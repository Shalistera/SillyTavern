# SillyTavern

LLM Frontend for Power Users

## Improvements in this fork

### Use new models without an extension

Open **API Connections**, choose a Chat Completion source, enter its exact **Model ID**, and click **Use model** (or press Enter). Models do not have to appear in the built-in dropdown or the provider's model catalog. For example, a new Vertex model can be selected as soon as your endpoint supports its ID.

The selection uses the normal model setting, so requests, presets, connection profiles, and model-dependent settings stay in sync. Custom IDs are remembered separately for each source and survive page reloads and catalog refreshes. You can still select a built-in model from the dropdown. Model capabilities and context limits continue to use the existing provider settings; entering a new ID does not discover its capabilities automatically.

The same editor is available for the Text Completion backends Mancer, Together AI, Infermatic AI, DreamGen, OpenRouter, vLLM, Aphrodite, Featherless, and llama.cpp. Generic and Text Generation WebUI retain their existing free-text model inputs. Backends that manage loaded/downloaded models retain their own controls.

Scripts can use `/model exact=true your-model-id` for an exact selection; the default `/model` command keeps its existing fuzzy search behavior. Connection profiles restore model IDs exactly.

### Performance and reliability

- Reopening unchanged chat lists reuses bounded, per-file summaries instead of reading every JSONL file again. File identity, size, and modification/change times are checked on every lookup; content reads are limited to eight at a time.
- First scans count JSONL lines as bytes and decode only metadata, search candidates, and the final preview. Searches satisfied entirely by a filename can reuse a cached summary without reading the message content.
- Chat history search cancels obsolete requests and ignores late responses when the query, character, or view changes. Lists are inserted in one batch, and a disconnected search stops scanning additional files on the server.
- Large chats use a single pass to select message tags, and keyboard controls share one deduplicated selector query. Repeated initialization preserves custom Tab order and does not accumulate scroll-reset listeners. Switching message swipes keeps one avatar fallback listener.
- Media-load scrolling counts each image/audio/video once and removes its listeners after completion or the existing one-second deadline. A new wait cancels the previous wait and releases its pending listeners.
- Concurrent template renders share one download and compilation while preserving separate data, sanitization, and localization for each render.
- Streaming reuses unchanged answer Markdown during reasoning/tool updates, while still running formatter hooks, regexes, and sanitization. Final rendering refreshes the conversion. Connection-test panels also reuse unchanged reasoning/body output, with independent caches cleared when hidden.
- Markdown restores ordinary inline HTML spans in one scan, with the original ordered parser retained for unusual extension substitutions. Stream fading reuses bounded, detached word templates and skips unchanged DOM subtrees while preserving form properties and keyed elements.
- Existing character-card disk-cache hits populate the configured memory cache, so repeated character-list requests avoid rereading each metadata file. Memory limits, card modification checks, and Android behavior are preserved.
- Character.AI multi-history imports work correctly, and imported chats do not overwrite existing files with colliding names.
- Connection checks ignore obsolete responses after switching sources or reconnecting, preserving the current model and connection status.
- Reinitializing reasoning controls or clicking Done repeatedly no longer overwrites reasoning text with `undefined` or saves the same edit twice.

### Local verification

Install application dependencies with `npm ci` and test dependencies with `npm --prefix tests ci`. Run `npm run lint`, `npm --prefix tests run test:unit`, and `npm --prefix tests run test:native` for the static and server checks.

Browser tests require a running instance and Chromium (`cd tests && npx playwright install chromium`). Use an isolated data directory when testing, for example:

```sh
node server.js --port 18347 --dataRoot /tmp/sillytavern-tests --browserLaunchEnabled false
```

In another terminal, run `ST_BASE_URL=http://127.0.0.1:18347 npm --prefix tests run test:e2e -- --workers=1`. The existing native browser checks also use `ST_BASE_URL` when it is set.

Compare chat-summary reads with a locally available Git revision:

```sh
node tests/bench-chat-info.mjs --baseline b34249a6c --rounds 5 32 1000
```

These are also the defaults. The benchmark alternates version order, waits for every file stream to close, reports each run plus medians and ranges, and removes its temporary chats. It loads the baseline chat endpoint with the working tree's supporting modules and dependencies. Use `--help` for the options.

At commit `78a22e873`, five rounds over 32 synthetic chats containing 1,000 messages each (64.18 MiB) reduced median repeated-read time from **141.10 ms to 1.00 ms**, and repeated content reads from 64.18 MiB to zero. First-scan time was essentially unchanged (141.73 ms versus 142.52 ms), while stream concurrency fell from 32 to 8. The subsequent scan improvements are measured below.

The second performance pass compares against `78a22e873`:

| Synthetic workload | Before | After |
| --- | ---: | ---: |
| Redisplay 2,000 messages, render completion | 4,652 ms | 3,416 ms |
| Same chat, including two animation frames | 7,100 ms | 5,400 ms |
| 131,100-character reply, Markdown conversion across 12 growing updates | 6,263 ms | 381 ms |
| Same reply, median fade DOM update | 595 ms | 224 ms |
| 98.18 MiB multilingual chat, first summary scan | 629.64 ms | 116.23 ms |
| Same file, filename match with an already cached summary | 829.96 ms | 0.71 ms |
| 200 character cards, metadata files read by a repeated list request | 200 | 0 |

The large-file first scan still reads the full file, but process CPU fell from 619.92 ms to 159.41 ms. The filename-match case avoids the full 98.18 MiB read. Full-text searches with no match still inspect every message: the large multilingual fixture improved modestly (822.42 ms to 750.39 ms), while the 1.29 MiB short-message workload was essentially unchanged. Character-list metadata reads fell from 200 files to zero after the first request; responses still require stat checks, JSON serialization, and parsing.

File scan timings are medians of five alternating rounds. Browser results use Chromium 141, synthetic English/Japanese text, and the actual application renderers; they exclude provider/network latency. Chat redisplay includes tags and keyboard initialization; the streaming benchmark measures formatting and detached DOM updates separately. The system disk cache was **not cleared**, and this is a shared machine, so timings fluctuate. These are specific workload measurements, not a claim about total application speed.

Reproduce server measurements without a running instance:

```sh
node tests/bench-chat-scans.mjs --rounds 5
node tests/bench-chat-scans.mjs --rounds 5 --repeats 8
node tests/bench-character-list.mjs
```

For streaming, start an isolated server as above and compare the committed utility modules with the working tree:

```sh
ST_BASE_URL=http://127.0.0.1:18347 ST_STREAM_BASELINE=78a22e873 node tests/bench-stream-render.mjs
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-stream-render.mjs
```

Exercise continuously growing single paragraphs and entirely new text on every update:

```sh
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-stream-cache-misses.mjs
```

This isolated DOM benchmark runs baseline/current/current/baseline with separate caches for segmentation and fade phases. In two runs, growing 8k-character paragraphs improved from 15.5–16.3 ms to 11.6 ms per fade update. Cache misses do add work to the segmentation phase alone (5.6–5.9 ms to 6.8 ms here); the complete fade update was faster across the tested 4k/8k/32k single paragraphs and 32k changing paragraph batches.

For long-chat redisplay, provide the old tag and keyboard modules to the browser benchmark, then run without those overrides. No checkout changes are needed:

```sh
git show 78a22e873:public/scripts/tags.js > /tmp/st-tags-before.js
git show 78a22e873:public/scripts/keyboard.js > /tmp/st-keyboard-before.js
ST_BASE_URL=http://127.0.0.1:18347 BENCHMARK_TAGS_SOURCE=/tmp/st-tags-before.js BENCHMARK_KEYBOARD_SOURCE=/tmp/st-keyboard-before.js node tests/bench-chat-render.mjs
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-chat-render.mjs
```

Run benchmarks separately from browser tests and other heavy work for more useful comparisons. None of these fixtures require an API key or modify real chats.

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
