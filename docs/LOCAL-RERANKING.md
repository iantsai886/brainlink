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

When local reranking is enabled in Setup, the RSI experiment list offers **Local reranker test set (fictional notes)**. It compares normal search with the configured local service using 21 bundled fictional cases. The test is manual, runs only after an RSI idea enters `testing` with candidate version `local-reranker-v1`, and stores only aggregate, commit-bound evidence. It sends synthetic questions and eligible snippets to the loopback service; it never reads connected vaults. A failed service call aborts the experiment so normal-search fallback cannot be mistaken for a reranker result.

This development set is not an independent held-out benchmark. The receipt does not certify which model is installed, measure generated answers or provider-billed token savings, or change live search. Human review is still required.
