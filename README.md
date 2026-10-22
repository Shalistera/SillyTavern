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
- Group lists index chat filenames once per request and reuse shared chat file stats within that request. The next request still reads fresh group data and file stats.
- World-info and persona searches use linear membership checks while retaining input order, duplicate entries, object identity, and search scores. Closed-folder filtering checks each character's or group's own tags instead of searching every folder for every entity.
- Plain-text macro expansion skips unused pattern construction and parsing while retaining environment setup, legacy markers, and pre/post processors.
- Frontend library builds reuse their cache across unrelated Git commits. Entry, build configuration, package/lockfile, Webpack, and Node changes identify new builds; the compiler still validates imported modules using its normal filesystem snapshots.
- Failed token-count requests settle through the existing fallback instead of leaving asynchronous callers waiting forever after an HTTP/network error. Empty responses also use the fallback, with the existing retry limit preserved.
- Concurrent requests for the same tokenizer share one pending model initialization and receive an instance only after it is ready. Failed loads can be retried by a later request; encoding uses one consistent instance for token IDs, counts, and chunks. Different models can still initialize independently.
- Token counts load and persist per chat. A small LRU retains up to four resident chat buckets when operations are idle, with in-flight consumers temporarily retained until safe to release; writes made during persistence remain dirty. Deletion/reset cannot resurrect pending counts, and connection parameters are captured before asynchronous cache loads. The old monolithic token-count cache is discarded without parsing it; counts are recomputed as needed, and chat messages are untouched.
- Hidden tabs limit expensive streaming previews to four per second (or the user's slower setting), while receiving every chunk and emitting every token event. Returning to the foreground restores the configured rate, and completion always renders the final message.
- Loading very large chats avoids JavaScript's function-argument limit while preserving the shared chat array and message order. Group, character, neutral-chat, and clipboard-history replacement use the same helper.
- PNG/WebP animation probes read at most the same 200-byte header examined by the existing detectors. Static thumbnail generation no longer reads an entire original twice just to check its animation flag.
- Six independent startup message templates download concurrently, while message construction, settings initialization, and extension activation keep their existing order.
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

The third performance pass compares against `bebe62bda`:

| Synthetic workload | Before | After |
| --- | ---: | ---: |
| HTTP group list, 200 groups and 4,000 chat files | 552.29 ms | 36.84 ms |
| Same groups, plus 20 chat files shared by every group | 590.97 ms | 48.78 ms |
| World-info search with 10,000 matching entries, including Fuse | 263.9 ms | 118.3 ms |
| Persona search with 10,000 matching entries, including Fuse | 376.9 ms | 54.0 ms |
| Build the entity list for 5,000 characters and 500 folders | 1,009.3 ms | 666.4 ms |
| Legacy macro substitution, 131k-character plain text, 100 calls | 113.4–113.9 ms | 64.6–65.8 ms |
| New-engine macro substitution, same text and call count | 169.7–177.6 ms | 80.6–80.7 ms |
| Library rebuild after an unrelated revision change | 20.43–21.46 s | 0.90–1.07 s |

Group measurements are medians of five alternating runs through the real HTTP route, including JSON serialization and parsing. The 4,000-file case reduces repeated path parsing from 800,000 to 4,000 operations; it still performs 4,000 fresh file stats. Shared-chat stats fall from 8,000 to 4,020 per request. Counts are measured separately from timings so probes do not distort the hot loop. Responses are compared for exact equality, and no persistent cache is introduced.

Search and folder timings are medians of seven alternating measurement rounds in Chromium, excluding DOM rendering and pagination. Folder measurements include entity-list and filter construction, excluding sorting. With search results already available, score caching and filtering drop from 113.2 to 3.0 ms for world info and 323.0 to 4.7 ms for personas. No-match searches are essentially unchanged because Fuse remains the dominant cost. Macro measurements use baseline/current/current/baseline browser sessions and additionally run 254 differential checks covering outputs and processor side effects. Short-string timings are noisy; the table reports the larger text workload rather than extrapolating to every prompt. These comparisons substitute the baseline target modules while retaining the current supporting modules and dependencies.

Reproduce the third-pass measurements:

```sh
node tests/bench-group-list.mjs
node tests/bench-group-list.mjs --shared-chats 20
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-search-filters.mjs
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-folder-filters.mjs
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-macros.mjs
node tests/bench-webpack-cache.mjs
```

The Webpack benchmark builds the actual library entry and dependencies in temporary projects. It changes the revision reported to the old configuration while keeping build inputs fixed, checks identical emitted JavaScript, and reports rebuilt module counts. Separate native tests compile a changed local import, check build-input invalidation, exercise missing/alternative lockfiles, and verify old-cache pruning. Unrelated revision changes rebuilt 386 modules with the old configuration and zero with the new one; initial builds still compiled all 386 modules (22.36 s versus 21.89 s). A normal server restart also reused the library cache in 1.21 s. These measurements exclude provider latency and use the existing OS disk cache on a shared machine.

### Adaptations from TauriTavern

The [TauriTavern reference revision](https://github.com/Darkatse/TauriTavern/tree/edf728b67337eb45c82bbe5a13151d901cd74f4a) provides useful browser and I/O strategies independently of its Rust host. This fork keeps its Node server and browser deployment. Per-chat token persistence, background streaming policy, bounded animation-header reads, and large-array replacement were adapted with additional compatibility checks; their source references are included in the implementation. Parallel startup-template reads apply the same idea of overlapping independent work without moving extension lifecycle events.

| Synthetic workload | Before | After |
| --- | ---: | ---: |
| Read token counts for one active chat, 500 historical chats × 1,000 counts | 39.7 ms | 0.8 ms |
| Save one changed count in that fixture | 44.6 ms | 2.3 ms |
| Background previews over 500 chunks / five simulated seconds | 125 | 20 |
| Same background stream, processor and DOM execution time | 2,013–2,020 ms | 388–452 ms |
| Animation-probe original bytes, twelve ~2 MiB PNG or WebP files | ~24 MiB | 2,400 bytes |
| Static PNG generation original bytes, same fixture size | ~48 MiB | ~24 MiB |
| Initialize six templates with 100 ms added response delay each | 686–733 ms | 147 ms |

Token-cache timings are medians of seven alternating runs in real Chromium IndexedDB with warm storage and OS caches. The old serialized fixture is 8.34 MB; the active chat is 13.8 kB. The comparison measures cache reads/writes, excluding fixture preparation and the rest of application startup. Cache tests cover pending-load merges, switching chats or connections during a count, dirty writes during eviction, deletion/reset, storage failure, and bounded residency. The one-time legacy-cache removal trades previously calculated counts for avoiding a full historical-cache migration.

Streaming tests use the actual processor and Markdown/DOM path with a deterministic chunk clock and simulated tab visibility. The timing comparison runs baseline/current/current/baseline in a separate idle window; foreground preview counts remain 125 and execution times are similar. Every chunk, token event, final message, reasoning field, tool call, and final flush is checked; these numbers do not measure provider throughput. A 200,000-message neutral-chat restore also verifies the shared array's identity and every message's position.

Thumbnail I/O counts are measured separately from timing; five alternating rounds compare identical output hashes. The images use one-pixel PNGs with large ancillary chunks and synthetic animated WebP headers, so they demonstrate reduced reads rather than a general high-resolution decoding speedup. Template results use baseline/current/current/baseline with real HTML, injected response delay, and identical message data; they measure only template initialization. These comparisons use `46c47c5b0` target modules with current supporting code, except the token-cache benchmark, which directly reproduces the old whole-object storage operations.

A related backend audit fixed concurrent tokenizer initialization: controlled model-load tests through the actual Express routes confirm that eight simultaneous requests share one initialization, all wait for readiness, and a later request can recover after failure. This removes duplicate work and a premature-instance race without changing model selection rules.

The reference's complete chat virtualization, deferred extension initialization, and panel DOM parking need broader compatibility work. Directly applying its message `content-visibility` CSS failed a browser probe: ordinary scrolling and loading more messages worked, but jumps to messages 25 and 100 were displaced by roughly 3,400 pixels. That style is therefore not enabled here.

Reproduce the browser and I/O comparisons in isolated fixtures:

```sh
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-token-cache.mjs
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-streaming-preview.mjs
ST_BASE_URL=http://127.0.0.1:18347 node tests/bench-startup-templates.mjs
node tests/bench-thumbnail-header.mjs
```

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
