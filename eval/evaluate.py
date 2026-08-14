import json
import os
import sys
from collections import defaultdict
from pathlib import Path


# ── domain constants ──────────────────────────────────────────────────────────

TOOL_NAME = "update_form_field"

REFERENCE_TOPICS = [
    "collecting applicant personal details for a government certificate form",
    "asking about name, date of birth, gender, religion, community, or income",
    "Aadhaar number or identification information",
    "mode of delivery or document submission preferences",
    "job or employment status of family members",
]

SKIP_VALUES = {None, "", "(skipped)", "null", "undefined"}


# ── credential loading ────────────────────────────────────────────────────────

def load_vite_env() -> dict[str, str]:
    """Read VITE_* variables from .env.local / .env in the project root."""
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent
    for name in (".env.local", ".env"):
        env_file = project_root / name
        if env_file.exists():
            print(f"  Credentials from: {env_file.name}")
            return _parse_env_file(env_file)
    print("  [WARN] No .env.local found — relying on environment variables.")
    return {}


def _parse_env_file(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def apply_vite_env_to_aws(vite_env: dict[str, str]) -> None:
    mapping = {
        "VITE_AWS_ACCESS_KEY_ID":     "AWS_ACCESS_KEY_ID",
        "VITE_AWS_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
        "VITE_AWS_SESSION_TOKEN":     "AWS_SESSION_TOKEN",
        "VITE_BEDROCK_REGION":        "AWS_DEFAULT_REGION",
        "VITE_BEDROCK_MODEL_ID":      "BEDROCK_EVAL_MODEL",
    }
    for vite_key, aws_key in mapping.items():
        if vite_key in vite_env and not os.environ.get(aws_key):
            os.environ[aws_key] = vite_env[vite_key]


# ── data loading ──────────────────────────────────────────────────────────────

def load_samples(jsonl_path: str) -> list[dict]:
    samples = []
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                samples.append(json.loads(line))
    return samples


def load_ground_truth(jsonl_path: str) -> dict[str, dict[str, str]]:
    """
    Optional sidecar file that provides manually annotated correct values.

    Format — ground_truth.json (same directory as the JSONL):
      {
        "<sessionId>": { "<fieldId>": "<correct value>", ... },
        ...
      }

    Without this file the script runs in self-consistency mode
    (reference = actual → ToolCallAccuracy always 1.0).
    """
    gt_path = Path(jsonl_path).parent / "ground_truth.json"
    if gt_path.exists():
        print(f"  Ground truth: {gt_path.name}  ← real accuracy measurement")
        return json.loads(gt_path.read_text(encoding="utf-8"))
    print("  Ground truth: not found → self-consistency mode (TCA will be 1.0)")
    return {}


def generate_ground_truth_skeleton(samples: list[dict], out_path: Path) -> None:
    """Write a skeleton ground_truth.json pre-filled with the system's actual
    assignments. Edit the values to reflect what the CORRECT answer should be."""
    by_session: dict[str, list[dict]] = defaultdict(list)
    for s in samples:
        by_session[s["sessionId"]].append(s)

    gt: dict[str, dict[str, str]] = {}
    for session_id, turns in by_session.items():
        gt[session_id] = {
            t["fieldId"]: str(t.get("assignedValue") or "")
            for t in turns
        }

    out_path.write_text(json.dumps(gt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nGround-truth skeleton written to {out_path}")
    print("Edit the values to the CORRECT expected extractions, then re-run.")


# ── JSONL → MultiTurnSample conversion ───────────────────────────────────────

def _make_tool_call(field_id: str, value) -> "ToolCall":  # noqa: F821
    """Create a Ragas ToolCall representing one field extraction."""
    from ragas.messages import ToolCall
    if str(value) in SKIP_VALUES:
        return ToolCall(name="skip_field", args={"field_id": field_id})
    return ToolCall(
        name=TOOL_NAME,
        args={"field_id": field_id, "value": str(value)},
    )


def sessions_to_multi_turn_samples(
    samples: list[dict],
    ground_truth: dict[str, dict[str, str]],
) -> list:
    """
    Group per-field JSONL records by session and convert each session into one
    MultiTurnSample representing the full multi-turn conversation.

    Conversation structure per field turn
    ──────────────────────────────────────
      AIMessage(content=ttsPrompt)               ← agent asks the question
      HumanMessage(content=userUtterance)        ← user responds by voice
      AIMessage(tool_calls=[ToolCall(...)])       ← agent calls update_form_field
    """
    from ragas.messages import HumanMessage, AIMessage, ToolCall
    from ragas.dataset_schema import MultiTurnSample

    by_session: dict[str, list[dict]] = defaultdict(list)
    for s in samples:
        by_session[s["sessionId"]].append(s)

    multi_turn_samples = []

    for session_id, turns in by_session.items():
        turns.sort(key=lambda t: t.get("timestamp", ""))

        messages = []
        ref_tool_calls: list[ToolCall] = []
        session_gt = ground_truth.get(session_id, {})

        for turn in turns:
            field_id    = turn.get("fieldId", "")
            field_label = turn.get("fieldLabel", field_id)
            tts_prompt  = turn.get("ttsPrompt") or f"Please provide: {field_label}"
            utterance   = turn.get("userUtterance") or "(no utterance recorded)"
            actual_val  = turn.get("assignedValue")

            # Agent speaks the question
            messages.append(AIMessage(content=tts_prompt))

            # User responds by voice — store sessionId in metadata for later lookup
            messages.append(HumanMessage(
                content=utterance,
                metadata={"sessionId": session_id, "fieldId": field_id},
            ))

            # Agent calls the extraction tool with the extracted value
            actual_tc = _make_tool_call(field_id, actual_val)
            messages.append(AIMessage(content="", tool_calls=[actual_tc]))

            # Reference: ground truth if annotated, else self-consistency
            ref_val = session_gt.get(field_id)
            ref_tc = _make_tool_call(field_id, ref_val) if ref_val is not None else actual_tc
            ref_tool_calls.append(ref_tc)

        multi_turn_samples.append(
            MultiTurnSample(
                user_input=messages,
                reference_tool_calls=ref_tool_calls,
                reference_topics=REFERENCE_TOPICS,
            )
        )

    return multi_turn_samples


# ── LLM resolution ────────────────────────────────────────────────────────────
# Neither ToolCallAccuracy nor TopicAdherence needs embeddings — LLM only.

def resolve_llm():
    """
    Resolve an LLM judge for Ragas 0.4.x.

    Priority:
      1. AWS Bedrock via LiteLLM (VITE_AWS_* / AWS_* env vars)
      2. OpenAI (OPENAI_API_KEY)
      3. Ollama (OLLAMA_MODEL)
    """
    has_aws    = bool(os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE"))
    has_openai = bool(os.environ.get("OPENAI_API_KEY"))
    has_ollama = bool(os.environ.get("OLLAMA_MODEL"))

    if has_aws:
        return _resolve_bedrock_llm()
    if has_openai:
        print("LLM judge: OpenAI (OPENAI_API_KEY)")
        return None  # Ragas uses OpenAI by default when no llm is set
    if has_ollama:
        return _resolve_ollama_llm()

    print(
        "\n[WARN] No LLM backend found.\n"
        "  Set VITE_AWS_ACCESS_KEY_ID in .env.local, or OPENAI_API_KEY.\n"
    )
    return "skip"


def _resolve_bedrock_llm():
    """
    Build an InstructorBaseRagasLLM backed by AWS Bedrock (Claude).

    ragas 0.4.x requires client to be an instructor.AsyncInstructor with
    client.chat.completions.create(..., response_model=PydanticModel) support.

    We achieve this via:
      anthropic.AsyncAnthropicBedrock  →  instructor.from_anthropic()
      →  LiteLLMStructuredLLM(client=instructor_client, model=..., provider="bedrock")
    """
    model_id = os.environ.get("BEDROCK_EVAL_MODEL", "anthropic.claude-3-haiku-20240307-v1:0")
    region   = os.environ.get("AWS_DEFAULT_REGION", "ap-south-1")
    os.environ.setdefault("AWS_DEFAULT_REGION", region)

    print(f"LLM judge: AWS Bedrock (Anthropic SDK + instructor)")
    print(f"  model  : {model_id}")
    print(f"  region : {region}")

    import anthropic
    import instructor
    from ragas.llms import LiteLLMStructuredLLM

    bedrock_async_client = anthropic.AsyncAnthropicBedrock(
        aws_access_key=os.environ.get("AWS_ACCESS_KEY_ID", ""),
        aws_secret_key=os.environ.get("AWS_SECRET_ACCESS_KEY", ""),
        aws_session_token=os.environ.get("AWS_SESSION_TOKEN"),
        aws_region=region,
    )

    # instructor.from_anthropic wraps the async client and adds
    # response_model support to client.chat.completions.create()
    instructor_client = instructor.from_anthropic(
        bedrock_async_client,
        mode=instructor.Mode.ANTHROPIC_TOOLS,
    )

    # max_tokens is required by Anthropic API; passed as model_args to every call
    return LiteLLMStructuredLLM(
        client=instructor_client,
        model=model_id,
        provider="bedrock",
        max_tokens=1024,
    )


def _resolve_ollama_llm():
    model = os.environ.get("OLLAMA_MODEL", "llama3")
    print(f"LLM judge: Ollama ({model})")
    try:
        import openai
        import instructor
        from ragas.llms import LiteLLMStructuredLLM
        # Ollama exposes an OpenAI-compatible API on localhost:11434
        ollama_async = openai.AsyncOpenAI(
            api_key="ollama",
            base_url="http://localhost:11434/v1",
        )
        instructor_client = instructor.from_openai(ollama_async)
        return LiteLLMStructuredLLM(client=instructor_client, model=model, provider="ollama")
    except Exception as e:
        print(f"  [WARN] Could not create Ollama instructor client ({e})")
        return "skip"


# ── evaluation ────────────────────────────────────────────────────────────────

def run_evaluation(
    multi_turn_samples: list,
    llm,
    jsonl_path: str,
    original_samples: list | None = None,
) -> None:
    """
    Evaluation strategy
    ───────────────────
    ToolCallAccuracy and TopicAdherence work at the SESSION level
    (one MultiTurnSample = one full form-filling conversation).

    However the results JSON contains ONE ROW PER FIELD TURN so that
    each original JSONL record has a corresponding eval result:

      session-level TCA / TA  — scores for the full conversation
      field-level  TCA        — TCA for just this field's 3-message turn
                                (question → user reply → tool call)

    This lets you see per-field extraction quality while still having
    the session-wide topicAdherence.
    """
    from ragas.messages import AIMessage, HumanMessage
    from ragas.dataset_schema import MultiTurnSample
    from ragas.metrics.collections import ToolCallAccuracy, TopicAdherence

    # strict_order=False — field order can vary; only arg values matter
    tca_metric = ToolCallAccuracy(strict_order=False)
    if llm is not None:
        tca_metric.llm = llm

    # TopicAdherence requires llm at construction time in ragas 0.4.x
    ta_metric = TopicAdherence(llm=llm)

    n_fields   = sum(len(s.reference_tool_calls) for s in multi_turn_samples)
    n_sessions = len(multi_turn_samples)
    print(f"\n  Metrics   : ToolCallAccuracy (strict_order=False), TopicAdherence")
    print(f"  Sessions  : {n_sessions}")
    print(f"  Field turns: {n_fields}")
    print("  Running evaluation …\n")

    # ── 1. SESSION-LEVEL scores ───────────────────────────────────────────
    tca_session_results = tca_metric.batch_score([
        {"user_input": s.user_input, "reference_tool_calls": s.reference_tool_calls}
        for s in multi_turn_samples
    ])
    ta_session_results = ta_metric.batch_score([
        {"user_input": s.user_input, "reference_topics": list(s.reference_topics or REFERENCE_TOPICS)}
        for s in multi_turn_samples
    ])

    session_scores = {
        i: {
            "tca": tca_session_results[i].value,
            "ta":  ta_session_results[i].value,
        }
        for i in range(n_sessions)
    }

    # ── 2. PER-FIELD scores ───────────────────────────────────────────────
    # Extract individual 3-message turns from each session's user_input.
    # Each turn = AIMessage (question) + HumanMessage (reply) + AIMessage (tool call).
    per_field_inputs = []
    per_field_meta   = []   # (session_idx, turn_idx, ref_tool_call)

    for s_idx, sample in enumerate(multi_turn_samples):
        msgs = sample.user_input
        refs = sample.reference_tool_calls
        # Messages are grouped in triples: AI-question, Human-reply, AI-tool-call
        turn_msgs = [msgs[i:i+3] for i in range(0, len(msgs), 3)]
        for t_idx, (turn, ref_tc) in enumerate(zip(turn_msgs, refs)):
            per_field_inputs.append({
                "user_input":           turn,
                "reference_tool_calls": [ref_tc],
            })
            per_field_meta.append((s_idx, t_idx, ref_tc))

    tca_field_results = tca_metric.batch_score(per_field_inputs)

    # ── 3. Build per-field results table ─────────────────────────────────
    import pandas as pd

    rows = []
    for i, (result, meta) in enumerate(zip(tca_field_results, per_field_meta)):
        s_idx, t_idx, ref_tc = meta
        ss = session_scores[s_idx]

        # Recover original sample metadata when available
        orig = None
        if original_samples:
            # Map (session_idx, turn_idx) to original record
            session_records = [r for r in original_samples
                               if r["sessionId"] == _session_id_for_sample(multi_turn_samples[s_idx])]
            if t_idx < len(session_records):
                orig = session_records[t_idx]

        field_id    = ref_tc.args.get("field_id", f"field-{t_idx}")
        field_value = ref_tc.args.get("value", "(skipped)")
        field_label = (orig or {}).get("fieldLabel", field_id)
        utterance   = (orig or {}).get("userUtterance", "")

        # First message of the turn is the TTS question
        turn_msgs_slice = per_field_inputs[i]["user_input"]
        question = next(
            (m.content for m in turn_msgs_slice if isinstance(m, AIMessage) and m.content),
            f"Field: {field_label}",
        )

        rows.append({
            "session_idx":                s_idx,
            "field_idx":                  t_idx,
            "field_label":                field_label,
            "field_id":                   field_id,
            "tts_question":               question,
            "user_utterance":             utterance,
            "assigned_value":             field_value,
            "tool_call_accuracy_field":   result.value,   # per-field TCA
            "tool_call_accuracy_session": ss["tca"],      # whole session TCA
            "topic_adherence_session":    ss["ta"],        # whole session TA
        })

    df = pd.DataFrame(rows)

    # ── 4. Print summaries ────────────────────────────────────────────────
    print("─" * 70)
    print(f"Aggregate (across {n_sessions} session(s), {n_fields} field turns):")
    print(f"  ToolCallAccuracy [session] : {df['tool_call_accuracy_session'].mean():.3f}")
    print(f"  ToolCallAccuracy [field]   : {df['tool_call_accuracy_field'].mean():.3f}")
    print(f"  TopicAdherence   [session] : {df['topic_adherence_session'].mean():.3f}")

    print(f"\nPer-field breakdown:")
    print(f"  {'Field':<35} {'Value':<20} {'TCA(F)':<8} {'TCA(S)':<8} {'TA(S)'}")
    print(f"  {'-'*35} {'-'*20} {'-'*8} {'-'*8} {'-'*6}")
    for _, row in df.iterrows():
        print(
            f"  {row['field_label']:<35}"
            f" {str(row['assigned_value']):<20}"
            f" {row['tool_call_accuracy_field']:<8.2f}"
            f" {row['tool_call_accuracy_session']:<8.2f}"
            f" {row['topic_adherence_session']:.2f}"
        )
    print("─" * 70)

    # ── 5. Export per-field results to JSON ───────────────────────────────
    out_path = Path(jsonl_path).parent / "eval_results.json"
    df.to_json(str(out_path), orient="records", force_ascii=False, indent=2)
    print(f"\nPer-field results ({len(df)} rows)  →  {out_path}")

    # ── 6. Push to Langfuse ───────────────────────────────────────────────
    _try_log_to_langfuse(df, multi_turn_samples)


def _session_id_for_sample(sample) -> str:
    """Extract sessionId from the first HumanMessage metadata, if stored there."""
    from ragas.messages import HumanMessage
    for m in sample.user_input:
        if isinstance(m, HumanMessage):
            sid = getattr(m, "metadata", {})
            if isinstance(sid, dict):
                return sid.get("sessionId", "")
    return ""


def _try_log_to_langfuse(df, samples: list) -> None:
    """
    Post metric scores to Langfuse so they appear alongside the voice-session traces.
    Requires VITE_LANGFUSE_PUBLIC_KEY + VITE_LANGFUSE_SECRET_KEY in .env.local.
    """
    pub  = os.environ.get("LANGFUSE_PUBLIC_KEY")  or os.environ.get("VITE_LANGFUSE_PUBLIC_KEY")
    sec  = os.environ.get("LANGFUSE_SECRET_KEY")  or os.environ.get("VITE_LANGFUSE_SECRET_KEY")
    host = os.environ.get("LANGFUSE_HOST")         or os.environ.get("VITE_LANGFUSE_BASE_URL")

    if not (pub and sec):
        return

    try:
        from langfuse import Langfuse
        lf = Langfuse(
            public_key=pub,
            secret_key=sec,
            **({"host": host} if host else {}),
        )

        for i, row in df.iterrows():
            # The sessionId is not currently embedded in MultiTurnSample metadata,
            # so we use a fallback trace_id. In production, pass sessionId via
            # MultiTurnSample metadata or a separate index.
            trace_id = f"eval-session-{i}"

            for metric_key in ("tool_call_accuracy", "topic_adherence"):
                score = row.get(metric_key)
                if score is not None and score == score:  # NaN check
                    lf.score(
                        trace_id=trace_id,
                        name=metric_key,
                        value=float(score),
                        comment="Ragas agentic evaluation",
                    )

        lf.flush()
        print("Ragas scores posted to Langfuse.")
    except Exception as e:
        print(f"  [WARN] Langfuse upload skipped: {e}")


# ── usage stats ───────────────────────────────────────────────────────────────

def print_stats(samples: list[dict]) -> None:
    total_in  = sum(s.get("inputTokens")  or 0 for s in samples)
    total_out = sum(s.get("outputTokens") or 0 for s in samples)
    n_sessions = len({s["sessionId"] for s in samples})

    print(f"\n{'─'*60}")
    print(f"Loaded {len(samples)} field samples across {n_sessions} session(s).")
    print(f"Token usage — in: {total_in:,}  out: {total_out:,}")
    cost = (total_in / 1_000) * 0.00025 + (total_out / 1_000) * 0.00125
    print(f"Estimated routing cost: ${cost:.4f} USD")

    with_tts = sum(1 for s in samples if s.get("ttsPrompt"))
    with_utt = sum(1 for s in samples if s.get("userUtterance"))
    skipped  = sum(1 for s in samples if s.get("assignedValue") is None)
    print(f"\nSarvam TTS prompts recorded : {with_tts}/{len(samples)}")
    print(f"STT utterances recorded     : {with_utt}/{len(samples)}")
    print(f"Fields skipped by user      : {skipped}")

    by_lang: dict[str, int] = {}
    for s in samples:
        lang = s.get("language", "?")
        by_lang[lang] = by_lang.get(lang, 0) + 1
    print("Languages:", "  ".join(f"{l}={n}" for l, n in sorted(by_lang.items())))
    print(f"{'─'*60}")


# ── simulated demo dataset ────────────────────────────────────────────────────

def demo_multi_turn_samples() -> list:
    """
    Minimal simulated dataset based on real character-certificate form data.
    Shows why ToolCallAccuracy is better than faithfulness for this use case.

    Turn 1 — Title:   user says "Mrs." → correct extraction → TCA contribution: 1.0
    Turn 2 — Gender:  user gives multi-field answer; agent extracts only "Male"
                      → correct partial extraction → TCA contribution: 1.0
    Turn 3 — Aadhaar: user says "7992. 42145418"; agent extracts "7992" (wrong —
                      should be "799242145418") → TCA contribution: 0.0
                      (faithfulness would also be 0.0 but for the wrong reason)
    Turn 4 — Middle name: user says "skip" → agent calls skip_field → reference also
                      skip → TCA contribution: 1.0  (faithfulness gives 0.0 for "")
    """
    from ragas.messages import HumanMessage, AIMessage, ToolCall
    from ragas.dataset_schema import MultiTurnSample

    def tc(field_id: str, value: str) -> ToolCall:
        return ToolCall(name=TOOL_NAME, args={"field_id": field_id, "value": value})

    def skip(field_id: str) -> ToolCall:
        return ToolCall(name="skip_field", args={"field_id": field_id})

    actual_aadhaar    = tc("aadhaar", "7992")           # WRONG — missing rest of digits
    reference_aadhaar = tc("aadhaar", "799242145418")   # CORRECT

    return [
        MultiTurnSample(
            user_input=[
                # Turn 1: Title
                AIMessage(content="Please tell me your Applicant's Title. Mr., Mrs., or Ms.?"),
                HumanMessage(content="Applicants Title Is Mrs."),
                AIMessage(content="", tool_calls=[tc("applicant_title", "Mrs.")]),

                # Turn 2: Gender — multi-field utterance; only gender extracted (correct)
                AIMessage(content="Please tell me your Gender. Female, Male, or Transgender?"),
                HumanMessage(content="I am a male. My date of birth is 23rd June 2002. "
                                     "My delivery method is online."),
                AIMessage(content="", tool_calls=[tc("gender", "Male")]),

                # Turn 3: Aadhaar — intentionally wrong to show non-1.0 TCA
                AIMessage(content="Please provide your Aadhaar Number."),
                HumanMessage(content="7992. 42145418"),
                AIMessage(content="", tool_calls=[actual_aadhaar]),

                # Turn 4: Middle name skipped — faithfulness=0.0 for "", TCA=1.0
                AIMessage(content="Please tell me your Middle Name."),
                HumanMessage(content="Skip middle name. And my name is Pankaj Bharadwaj."),
                AIMessage(content="", tool_calls=[skip("middle_name")]),
            ],
            reference_tool_calls=[
                tc("applicant_title", "Mrs."),
                tc("gender", "Male"),
                reference_aadhaar,       # correct Aadhaar — differs from actual
                skip("middle_name"),
            ],
            reference_topics=REFERENCE_TOPICS,
        )
    ]


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = sys.argv[1:]

    # Generate ground-truth skeleton
    if "--gen-gt" in args:
        idx = args.index("--gen-gt")
        jsonl_path = args[idx + 1] if idx + 1 < len(args) else "eval_data.jsonl"
        samples = load_samples(jsonl_path)
        generate_ground_truth_skeleton(samples, Path(jsonl_path).parent / "ground_truth.json")
        return

    print("Loading credentials …")
    apply_vite_env_to_aws(load_vite_env())

    # Demo mode — no JSONL needed
    if "--demo" in args:
        print("\nRunning in DEMO mode (simulated character-certificate data).")
        llm = resolve_llm()
        if llm == "skip":
            print("[SKIP] No LLM configured.")
            return
        run_evaluation(demo_multi_turn_samples(), llm, "eval_demo.jsonl", original_samples=None)
        return

    # Normal mode
    jsonl_path = next((a for a in args if not a.startswith("--")), "eval_data.jsonl")

    if not Path(jsonl_path).exists():
        print(f"\n[ERROR] File not found: {jsonl_path}")
        print(
            "\nUsage:\n"
            "  python eval/evaluate.py eval_data.jsonl   # real data from app\n"
            "  python eval/evaluate.py --demo            # test with simulated data\n"
            "  python eval/evaluate.py --gen-gt FILE     # scaffold ground_truth.json\n"
        )
        sys.exit(1)

    print(f"\nLoading {jsonl_path} …")
    samples = load_samples(jsonl_path)
    print(f"  {len(samples)} samples loaded")

    print_stats(samples)

    ground_truth = load_ground_truth(jsonl_path)

    usable = [s for s in samples if s.get("ttsPrompt") or s.get("userUtterance")]
    if not usable:
        print(
            "\n[SKIP] No samples with TTS prompts or STT utterances.\n"
            "  Make sure voiceObservability.recordPrompt() / recordTranscript() are wired."
        )
        return

    print(f"\nBuilding {len(usable)} samples into multi-turn sessions …")
    multi_turn_samples = sessions_to_multi_turn_samples(usable, ground_truth)
    print(f"  {len(multi_turn_samples)} session(s) ready")

    llm = resolve_llm()
    if llm == "skip":
        print("[SKIP] No LLM backend configured.")
        return

    run_evaluation(multi_turn_samples, llm, jsonl_path, original_samples=usable)


if __name__ == "__main__":
    main()
