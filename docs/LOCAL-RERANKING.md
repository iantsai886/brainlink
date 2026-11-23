# Optional local search reranking

BrainLink can send a small set of already-authorized search results to a reranking service running on the same computer. The service can reorder results by how well each one answers the question. This is optional and off by default.

## Set it up

1. Install and start a local rerank service that accepts a JSON `query`, `documents`, and `top_n` request and returns a list of document `index` and `relevance_score` values.
2. Bind the service to loopback only, such as `127.0.0.1`.
3. In BrainLink Setup, open **Settings → Local search reranking**, enter the local endpoint URL, and select **Test local connection**.
4. If the check succeeds, turn on **Use local reranking** and save.

The [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) documents a compatible `/v1/rerank` API. Its upstream reranking example starts the server with a supported reranker model, `--host 127.0.0.1`, `--embedding`, and `--pooling rank`. Model files and the rerank server are installed by the user; BrainLink does not download them. Use the endpoint path and port shown by the local service.

## Data and safety

- BrainLink checks vault permissions, private-note status, and search filters before building the candidate list.
- It sends only the query and up to 20 candidate titles, headings, and short snippets; it does not send note paths or whole notes.
- The configured URL must be plain HTTP on `localhost`, `127.0.0.1`, or `[::1]`, with no credentials or query string.
- Exact note links and explicit tag matches stay at the top.
- If the service is off, slow, or returns an unsupported response, BrainLink uses its normal search results.
- The connection test checks only that the service responds in the expected format. It does not measure ranking quality, token savings, or answer quality.

To turn the feature off, clear **Use local reranking** and save. BrainLink then uses its normal search ranking.

## RSI evaluation

When local reranking is enabled in Setup, the RSI experiment list offers two tests. **Local reranker test set (fictional notes)** compares search on 21 development cases. **Local reranker independent test set (fictional notes)** compares source ranking, task success, source recall, abstention, and privacy on a separate frozen set of 30 synthetic tasks. Both run only after an RSI idea enters `testing` with the matching candidate version and store aggregate, commit-bound evidence. They send synthetic questions and eligible snippets to the loopback service; they never read connected vaults. A failed service call aborts the experiment so normal-search fallback cannot be mistaken for a reranker result.

The 21-case set is a development set. The 30-task set is a frozen synthetic benchmark, not customer validation or proof of real-world model quality. Neither receipt certifies which model is installed, measures generated answers or provider-billed token savings, or changes live search. Human review is still required.
