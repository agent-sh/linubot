# Long-session compaction for Linubot

Evidence review and implementation decision

Research checked September 6, 2026. This report concerns a Linux desktop agent using multiple API providers, durable event logs, groups, tools, approvals and bot-managed memory. It reviews the major deployed and published method families relevant to that boundary, not every paper ever published. Research preceded Linubot's compaction implementation. See [current behavior](../../CONTEXT.md) for what the application implements.

## Decision

Build recoverable context management, with provider-native compaction where the selected endpoint supports it and a portable checkpoint fallback. Keep the full event archive. Preserve the current request, criteria, system instructions, tool authority and recent complete exchanges outside the summarizer's control. Mask older bulky observations before paying for a summary. Publish checkpoints atomically only after validating their source range, shape and usefulness. Give the bot a way to reopen original history.

This is an engineering synthesis, not a claim that one algorithm wins every benchmark. Compaction should reduce working context without silently deleting the user's records. Memory of preferences remains a separate store. A smaller prompt is useful only if the bot can still continue the task correctly.

## What the production agents actually do

### Claude Code: pruning, summaries and reloaded context

Anthropic documents removal of older tool output before conversation summarization. Manual compaction can take focus instructions. Root rules, memory and the plan are reloaded, with bounded restoration of recent files and invoked skills. Early conversational instructions can still be lost; persistent root instructions remain a separate layer. Triggers depend on the model and configuration. The public repository does not expose the production compactor, and this review found no current first-party recall benchmark that proves complete retention. Sources: [Anthropic, How Claude Code works, accessed 2026-09-06](https://code.claude.com/docs/en/how-claude-code-works), [Context window](https://code.claude.com/docs/en/context-window), [Model configuration](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction).

Rewind can summarize a selected region while preserving the other region and original transcript. File checkpoints are distinct from conversation compaction. They are not a universal undo system for shell-created changes. Source: [Anthropic, Checkpointing, accessed 2026-09-06](https://code.claude.com/docs/en/checkpointing).

### Codex: provider capability, retained context and durable replacement history

At examined revision 4aec2338, the default auto-compaction limit is 90% of resolved context, clamped by model/configuration limits. The harness has local and remote paths. Local compaction asks for a continuation handoff and retains a bounded newest-user-text region. Remote v2 reconstructs retained context and inserts the checkpoint. Persisted replacement history supports resume and fork. Source: [OpenAI, model limits](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/protocol/src/openai_models.rs#L515), [Local compaction](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/core/src/compact.rs), [Remote v2](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/core/src/compact_remote_v2.rs). Revision committed 2026-09-06 17:27 UTC.

The newer token-budget/fresh-context path is under development and disabled by default at this revision. It must not be described as the generic production behavior. Source: [OpenAI, feature declarations](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/features/src/lib.rs#L1594). Mocked resume/fork tests establish protocol and storage checks, not a general recall score: [Codex compaction tests](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/core/tests/suite/compact_resume_fork.rs).

### Hermes: lean summaries with recovery and transactional continuity

Current examined source defaults to lean compaction: deterministic pruning, a summary request, a recent token tail, bounded user quotations, identifier anchors and archive pointers. The source is more current than some public prose describing older defaults. The checkpoint commit is transactional and retains messages that arrived after summarization began, using a watermark and lease check. Sources: [Nous Research, compressor](https://github.com/NousResearch/hermes-agent/blob/57f05e2142f74d82177b1beab90d3e0661edd744/agent/context_compressor.py), [Atomic archive and compact](https://github.com/NousResearch/hermes-agent/blob/57f05e2142f74d82177b1beab90d3e0661edd744/hermes_state_messages.py#L508). Revision committed 2026-09-06 17:41 UTC.

Empty, truncated and transport/authentication failures do not justify replacing history with a bad generated summary. Recovery and anti-thrashing controls are bounded. Hermes' August scorecard found retrieval materially improved recall, but its four private transcripts, LLM grading, changed question banks and subsequent algorithm changes prevent using the numbers as a current product ranking. Source: [Nous Research, historical scorecard, 2026-08-15](https://github.com/NousResearch/hermes-agent/blob/57f05e2142f74d82177b1beab90d3e0661edd744/evals/compaction/results/SCORECARD-2026-08-15.md).

## Provider-native compaction

### OpenAI Responses

OpenAI documents both in-request compaction through context_management and an explicit responses/compact endpoint. The standalone response is the canonical replacement window: it can include retained items as well as an encrypted compaction item. Pass the complete output back unchanged. The encrypted representation is opaque. The standalone endpoint is stateless; server-side compaction is described as compatible with zero-data-retention workflows when store=false. These are API contracts, not independent guarantees that every fact survives. Source: [OpenAI, Compaction, accessed 2026-09-06](https://developers.openai.com/api/docs/guides/compaction).

### xAI Responses

xAI also documents responses/compact. Its response contains an opaque compaction item with usage counters, and the compacted context can be compacted again. Input must still fit the selected model's window; this is not an over-limit rescue operation. The blob must be returned unchanged to xAI. OAuth-account availability still requires a live account-specific test. Source: [xAI, Context Compaction, accessed 2026-09-06](https://docs.x.ai/developers/advanced-api-usage/context-compaction).

### Anthropic Messages

Anthropic's native strategy uses a compaction edit and compaction content blocks. It can pause after compaction so the client can restore selected recent exchanges before continuing. The documented trigger defaults to 150,000 tokens and has a 50,000-token minimum. Support is model/platform specific and beta-labeled. Old tool-result clearing is a separate mechanism that can retain tool inputs and recent pairs. These contracts cannot be assumed for every Anthropic-compatible proxy. Sources: [Anthropic, Compaction, accessed 2026-09-06](https://platform.claude.com/docs/en/build-with-claude/compaction), [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing).

For Linubot, bind native checkpoints to their originating connection/protocol/model and rebuild from the archive on incompatible switches. Preserve returned native items rather than translating their encrypted content into prose. Generic compatibility does not imply support for a native compaction endpoint.

## Method families and what their evidence means

### 1. Observation masking and hybrids

Replace older bulky tool observations with recoverable placeholders while retaining recent observations and the action trajectory. JetBrains/TUM's controlled SWE-agent study found masking competitive with model summaries at lower cost, and a hybrid improved the cost frontier. This favors pruning as a first stage, not permanent deletion. Masking alone does not bound an indefinitely growing conversation. Source: [Lindenbauer et al., The Complexity Trap, arXiv v3, 2025](https://arxiv.org/html/2508.21433v3).

### 2. Model-directed checkpointing

SelfCompact exposes a compaction tool and teaches suitable task boundaries with a rubric. Its evidence favors boundary-aware guidance over unconstrained model choice. It is a recent open-model study on math/search tasks; its gains are not a guarantee for arbitrary APIs. Linubot can let a bot request a checkpoint at a finished subtask while retaining deterministic pressure limits. Source: [Li et al., Self-Compacting Language Model Agents, arXiv v2, 2026](https://arxiv.org/html/2606.23525v2).

### 3. Failure-optimized summary instructions

ACON improves compression instructions using cases where full context succeeds but compressed context fails. It reduced peak tokens in its tested tasks, but lower estimated cost did not uniformly improve accuracy or latency. The transferable lesson is to improve checkpoint schemas using failed continuations and measure the summarizer's own cost. Source: [Kang et al., ACON, ICML 2026 / arXiv v3](https://arxiv.org/html/2510.00615v3).

### 4. Asynchronous validated compaction

Slipstream summarizes while the original-context agent continues, then checks a candidate against independently generated subsequent steps before adoption. Its coding/search experiments are promising, but future steps are an imperfect validator of all future needs. Adopt synchronous transactional checkpoints first; asynchronous adoption is a measured optimization that needs watermark handling and concurrency budgets. Source: [Chen et al., Slipstream, arXiv, 2026](https://arxiv.org/html/2605.08580v1).

### 5. Parallel block compaction

Parallel Context Compaction separately summarizes blocks to reduce wall time. It differs from asynchronous continuation validation. Blocks can lose dependencies across their boundaries, and concurrency can increase requests or cost. The inspected evidence for this item is abstract-level, so it is not a basis for a production performance promise. Source: [Cim et al., Parallel Context Compaction for Long-Horizon LLM Agent Serving, arXiv, 2026](https://arxiv.org/abs/2605.23296).

### 6. Dependency-aware eviction

Structured context eviction annotates episodes and dependencies, evicting recoverable content before active exploratory state. This supports preserving complete tool groups and unfinished work. Published continuous-session demonstrations are not equivalent to broad independent evaluation, and their aggregate processed-token counts are not active-window sizes. Source: [Semenov and Dorofeev, Beyond Compaction, arXiv, 2026](https://arxiv.org/html/2606.11213v1).

### 7. Hierarchical working and archival memory

MemGPT established explicit tiers and model-controlled movement between in-context and external memory. This is a strong architectural precedent for separating the working checkpoint, durable user facts and raw session history. It does not establish unlimited reliable recall. Source: [Packer et al., MemGPT, arXiv, 2023](https://arxiv.org/abs/2310.08560).

### 8. Gists plus recovery of originals

ReadAgent stores short episode gists and allows reopening the original passages. Its document-comprehension results support recoverable source references, but retrieval access alone does not guarantee the agent will ask for the right passage. Source: [Lee et al., A Human-Inspired Reading Agent with Gist Memory, Google DeepMind / arXiv, 2024](https://arxiv.org/abs/2402.09727).

### 9. Summary DAGs and immutable history

LCM combines immutable history, hierarchical summaries, search and expansion tools. Its losslessness claim concerns recoverability of original data, not lossless prose summarization. The published OOLONG result also uses parallel map/reduce tools, so it does not isolate conversational compaction quality. Source: [Ehrlich and Blackman, LCM, Voltropy, 2026-02-14](https://papers.voltropy.com/LCM).

### 10. Programmatic context exploration

Recursive Language Models put a large prompt in an external programming environment and let the agent inspect slices and recursively call models. This is useful for archive-analysis tasks, not a drop-in conversation summarizer. Average costs can be dominated by expensive outliers; recursion and total-call budgets matter. Source: [Zhang, Kraska and Khattab, Recursive Language Models, arXiv v3, 2025-2026](https://arxiv.org/html/2512.24601v3).

### 11. Consolidated long-term memory

SimpleMem combines extraction, consolidation and query-aware retrieval. Hindsight separates kinds of evidence and provides retain/recall/reflect operations. Both motivate source and time metadata, but their benchmark gains are not directly comparable across different readers and pipelines. They complement working-context compaction rather than replacing it. Sources: [Liu et al., SimpleMem, arXiv, 2026](https://arxiv.org/abs/2601.02553), [Latimer et al., Hindsight is 20/20, arXiv, 2025](https://arxiv.org/abs/2512.12818).

### 12. Trained state compression and subtask folding

MEM1, ReSum, Context-Folding and AgentFold train models or trajectories to maintain compact state or fold completed subtasks. Their tool boundaries are useful design ideas. Their trained-model gains cannot be claimed merely by exposing similarly named tools to another API model. Sources: [Zhou et al., MEM1, 2025](https://arxiv.org/abs/2506.15841), [Wu et al., ReSum, 2025](https://arxiv.org/abs/2509.13313), [Sun et al., Context-Folding, 2025](https://arxiv.org/abs/2510.11967), [Ye et al., AgentFold, 2025](https://arxiv.org/abs/2510.24699).

### 13. Token-level prompt compression

LLMLingua-2 uses a trained token classifier to select a shorter prompt. This can help large retrieved prose without changing the target model. It is risky for serialized tool calls, code, exact identifiers and constraints: deleting original tokens can still change meaning. It is not selected for Linubot's core control history. Source: [Pan et al., LLMLingua-2, ACL Findings, 2024](https://aclanthology.org/2024.findings-acl.57/).

### 14. Latent or soft-token compression

AutoCompressors learns summary vectors consumed by adapted models. These vectors are model-specific, unlike compressed plaintext, and ordinary API clients cannot inject them as generic messages. This family belongs in an inference/model integration, not this client-only implementation. Source: [Chevalier et al., Adapting Language Models to Compress Contexts, EMNLP, 2023](https://arxiv.org/abs/2305.14788).

### 15. KV-cache and engine-level methods

StreamingLLM retains attention sinks and recent cache state; KIVI quantizes keys and values. These reduce engine memory costs, not the text sent by an API client. A later study found that KV eviction can degrade instruction following. Long streaming fluency is not proof of remembering discarded content. Sources: [Xiao et al., StreamingLLM, ICLR 2024](https://arxiv.org/abs/2309.17453), [Liu et al., KIVI, ICML 2024](https://arxiv.org/abs/2402.02750), [Chen et al., Pitfalls of KV Cache Compression, revised 2026](https://arxiv.org/abs/2510.00231).

## Evaluation and failure boundaries

LongMemEval tests extraction, updates, temporal reasoning, multi-session reasoning and abstention. LongMemEval-V2 extends evaluation toward changing agent state, workflows, environment gotchas and invalid premises. Both are useful references, but neither alone proves repeated compaction integrity. Sources: [Wu et al., LongMemEval, ICLR 2025](https://github.com/xiaowu0162/LongMemEval), [Wu et al., LongMemEval-V2, 2026](https://arxiv.org/abs/2605.12493).

Governance Decay's synthetic tool-graded study shows why operator constraints cannot be left solely to a lossy summary. Pinning explicit constraints helped its tested failures but did not solve operator-impersonation attacks. The application must enforce authority and provenance itself. Source: [Chen, Governance Decay, arXiv v2, 2026](https://arxiv.org/html/2606.22528v2).

Repeated compaction lacks a universal shared evaluation budget across text, learned-state and cache-level methods. A rate-distortion view is helpful for framing the tradeoff but is not a demonstrated universal winner. Source: [Colaco and Lahjouji, What to Keep, What to Forget, arXiv, 2026](https://arxiv.org/abs/2607.08032).

| Required check | What must be demonstrated |
| --- | --- |
| Continuation | Current objective, unfinished steps, failures, exact paths/IDs and sources survive or are recoverable. |
| Corrections | New state supersedes old state; memory forgetting is not undone by checkpoint writes. |
| Tool integrity | Call/result groups remain valid; no side effect is replayed and no approval is fabricated. |
| Concurrency | Input arriving during compaction remains after the committed source watermark. |
| Restart and routing | Checkpoints survive restart; incompatible native state is rebuilt when provider/model changes. |
| Failure | Empty, malformed, oversized, non-reducing or failed candidates cannot replace good state. |
| Utility | Record task success, redundant calls, recall, usage and elapsed time, including compaction overhead. |

## Implementation decisions

At the research baseline, Linubot had durable run/event logs but limited recalled conversation by message count and characters, with a hard in-run context guard. The proposed replacement retained archive records and derived versioned working checkpoints from explicit source ranges. A raw recent suffix and the current request would remain independent of the condensed prefix. That design is now implemented; [the context guide](../../CONTEXT.md) describes its behavior and limits.

Keep system/workflow text, the active request and criteria, live tool grants/denials, and current bot/user memory authoritative outside compaction. Historical user instructions still require retention and retrieval; no bounded summary can promise to keep every historical sentence verbatim forever. Checkpoints are historical evidence and must never grant tool authority.

Use provider usage when available and conservative estimates for newly appended material. Reserve output space, trigger before overflow, and require enough reduction before adoption. Use cooldowns to avoid repeated ineffective compaction. Do not guess that all providers with the same wire protocol support the same context window or native compact endpoint.

The byte length of an opaque encrypted item is not a reliable token estimate. Use the provider's usage information and measure the follow-up input, with a clearly labeled estimate where exact counting is unavailable.

Start with synchronous, validated adoption and archive recovery. Add asynchronous validators, learned compressors, recursive exploration or more complex summary graphs only when measured failures or latency justify them. This keeps the initial implementation reviewable while preserving an upgrade path.

## Scope, disagreements and stopping rule

Discovery covered current production systems, native APIs, pruning, semantic checkpoints, retrieval, hierarchy, trained compression, latent state, KV compression and evaluation. Follow-up checked the most consequential claims against primary documents and pinned source: native output handling, authority preservation, and transactional concurrent-append behavior. Documentation/source drift in Hermes and experimental/default distinctions in Codex were resolved in favor of the examined source revisions.

Some papers are recent preprints, one parallel-compaction item was reviewed at abstract level, Claude's implementation is closed, and published product scorecards are not directly comparable. No study qualifies this exact Linubot/provider/task combination. Research stopped when every major method family had primary support or an explicit limitation, and additional broad search was unlikely to change the first implementation decision. [Live acceptance and failure-injection tests](../../VALIDATION.md) remain necessary for each implementation change.
