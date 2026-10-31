import { useEffect, useState } from "react";
import { DiffReview } from "./DiffReview.js";
import {
  bindingStatus,
  replaceLinkedPassage,
  MAX_SOURCE_VERSION,
  emptyWorkbench,
  evidenceStatus,
  importedValue,
  readWorkbench,
  refreshedBinding,
  responseLetter,
  uniquePassage,
  type Workbench,
  type WorkbenchFile,
} from "../document-workbench.js";
import "./document-workbench.css";
import type { CompileInput, RenderResult } from "@galley/shared";
import type { Compiler } from "@galley/compiler";
import { initCompiler } from "../compiler-assets.js";
import { compileInputKey } from "../useCompiler.js";
import { Preview } from "./Preview.js";

import {
  workbenchScratchInput,
  type WorkbenchAcceptRequest,
} from "../document-workbench-apply.js";

type Proposal = {
  id: string;
  targetFileId: string;
  targetPath: string;
  base: string;
  next: string;
  search: string;
  replace: string;
  metadata: Workbench;
  originalMetadata: string;
  sources: { path: string; text: string }[];
  input: CompileInput;
  expectedInputKey: string;
  expectedScratchInputKey: string;
};
export function DocumentWorkbench({
  files,
  activePath,
  activeFileId,
  source,
  metadataText,
  canMutate,
  onSave,
  onAccept,
  buildInput,
  onImportSource,
}: {
  onImportSource: (name: string, text: string) => boolean;
  buildInput: (scratch: string) => CompileInput;
  files: WorkbenchFile[];
  activePath: string;
  activeFileId: string;
  source: string;
  metadataText: string;
  canMutate: boolean;
  onSave: (next: string, expected: string) => boolean;
  onAccept: (run: WorkbenchAcceptRequest) => boolean;
}) {
  const [message, setMessage] = useState("");
  const [compiled, setCompiled] = useState(false);
  const [pending, setPending] = useState<Proposal | null>(null);
  let data = emptyWorkbench();
  let invalid = false;
  try {
    if (metadataText) data = readWorkbench(metadataText);
  } catch {
    invalid = true;
  }
  const save = (next: Workbench, expected = metadataText) => {
    const serialized = JSON.stringify(next, null, 2);
    try {
      readWorkbench(serialized);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
    const ok = onSave(serialized, expected);
    setMessage(
      ok
        ? "Saved in this project."
        : "Project metadata changed. Review the current records and retry.",
    );
    return ok;
  };
  const act = (action: () => void) => {
    try {
      action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const submit = (
    form: HTMLFormElement,
    kind: "binding" | "evidence" | "review",
  ) =>
    act(() => {
      const f = new FormData(form);
      const text = (key: string) => String(f.get(key) ?? "").trim();
      const passage = text("passage");
      if (!uniquePassage(source, passage))
        throw new Error(
          "Paste a passage occurring exactly once in the current document.",
        );
      const id = crypto.randomUUID();
      if (kind === "review") {
        const comment = text("comment");
        if (!comment) throw new Error("Paste a reviewer comment.");
        if (
          save({
            ...data,
            reviews: [
              ...data.reviews,
              {
                id,
                comment,
                passage,
                targetPath: activePath,
                revision: text("revision"),
                response: text("response"),
                state: "open",
              },
            ],
          })
        )
          form.reset();
        return;
      }
      const matches = files.filter((file) => file.path === text("origin"));
      if (matches.length !== 1)
        throw new Error("Source path is missing or ambiguous");
      const origin = matches[0];
      if (!origin) throw new Error("Choose a source project file.");
      if (origin.text.length > MAX_SOURCE_VERSION)
        throw new Error(
          "Source is too large to retain a version (500 KB limit).",
        );
      if (kind === "binding") {
        const value = importedValue(origin.text, origin.path, text("selector"));
        if (!uniquePassage(passage, value))
          throw new Error(
            `The selected value (${value}) must occur exactly once in the passage.`,
          );
        if (
          save({
            ...data,
            bindings: [
              ...data.bindings,
              {
                id,
                name: text("name"),
                passage,
                targetPath: activePath,
                sourcePath: origin.path,
                sourceVersion: origin.text,
                selector: text("selector"),
                value,
              },
            ],
          })
        )
          form.reset();
      } else {
        const excerpt = text("excerpt");
        if (excerpt && !origin.text.includes(excerpt))
          throw new Error("The excerpt must occur in the source version.");
        if (
          save({
            ...data,
            evidence: [
              ...data.evidence,
              {
                id,
                passage,
                targetPath: activePath,
                sourcePath: origin.path,
                sourceVersion: origin.text,
                excerpt,
                reviewed: false,
              },
            ],
          })
        )
          form.reset();
      }
    });
  const propose = (
    search: string,
    replace: string,
    metadata: Workbench,
    sources: Proposal["sources"] = [],
  ) => {
    if (!uniquePassage(source, search))
      throw new Error(
        "Linked passage changed or ambiguous. Relink it before proposing.",
      );
    readWorkbench(JSON.stringify(metadata));
    const next = replaceLinkedPassage(source, search, replace);
    const input = workbenchScratchInput(
      buildInput(next),
      activePath,
      next,
      JSON.stringify(metadata, null, 2),
    );
    setCompiled(false);
    setPending({
      id: crypto.randomUUID(),
      targetFileId: activeFileId,
      targetPath: activePath,
      base: source,
      next,
      search,
      replace,
      metadata,
      originalMetadata: metadataText,
      sources,
      input,
      expectedInputKey: compileInputKey(buildInput(source)),
      expectedScratchInputKey: compileInputKey(input),
    });
  };
  const staleProposal =
    pending !== null &&
    compileInputKey(buildInput(source)) !== pending.expectedInputKey;
  const origins = files.filter((file) => !file.path.includes("/.galley/"));
  const sourcePicker = (
    <label>
      Source project file
      <select name="origin" aria-label="Source project file" required>
        {origins.map((file) => (
          <option key={file.fileId} value={file.path}>
            {file.path}
          </option>
        ))}
      </select>
    </label>
  );
  const passageInput = (
    <label>
      Exact linked passage in {activePath}
      <textarea name="passage" required />
    </label>
  );
  return (
    <details className="document-workbench" data-testid="document-workbench">
      <summary>
        Document workbench · numbers, evidence, reviewer responses
      </summary>
      <p>
        Explicit links and retained source versions stay in this project. Review
        states record your decisions; they do not verify truth.
      </p>
      {message && <p role="status">{message}</p>}
      {invalid ? (
        <p role="alert">
          Workbench metadata is invalid or unsupported. Repair
          /.galley/workbench.json before saving. Existing metadata has been
          preserved.
        </p>
      ) : (
        <>
          <fieldset disabled={!canMutate}>
            <legend>Living numbers</legend>
            <p>
              Import a CSV or JSON using the file tree, then link one scalar to
              a unique passage. Changed source versions flag potentially stale
              prose.
            </p>
            <label>
              Import project CSV or JSON
              <input
                type="file"
                accept=".csv,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  if (file.size > MAX_SOURCE_VERSION) {
                    setMessage(
                      "Data file exceeds the 500 KB retained-version limit",
                    );
                    return;
                  }
                  void file
                    .text()
                    .then((text) => {
                      if (!/\.(csv|json)$/i.test(file.name))
                        throw new Error("Choose a CSV or JSON file");
                      if (file.name.toLowerCase().endsWith(".json"))
                        JSON.parse(text);
                      setMessage(
                        onImportSource(file.name, text)
                          ? "Data file imported into this project."
                          : "Import failed: the path exists or this project is read-only. Rename the file and retry.",
                      );
                    })
                    .catch((error) =>
                      setMessage(
                        error instanceof Error ? error.message : String(error),
                      ),
                    );
                }}
              />
            </label>
            <form
              aria-label="Bind a living number"
              onSubmit={(event) => {
                event.preventDefault();
                submit(event.currentTarget, "binding");
              }}
            >
              <label>
                Value name
                <input name="name" required />
              </label>
              {sourcePicker}
              <label>
                JSON dot path or CSV row.header
                <input
                  name="selector"
                  placeholder="totals.revenue or 1.revenue"
                  required
                />
              </label>
              {passageInput}
              <button type="submit">Bind current value</button>
            </form>
            {data.bindings.map((binding) => (
              <article key={binding.id}>
                <strong>
                  {binding.name}: {binding.value}
                </strong>
                <p>
                  {binding.targetPath} ← {binding.sourcePath} ·{" "}
                  {binding.selector}
                </p>
                <p>{bindingStatus(binding, files)}</p>
                <blockquote>{binding.passage}</blockquote>
                <RelinkForm
                  files={origins}
                  activePath={activePath}
                  onLink={(passage, origin) =>
                    act(() => {
                      if (!uniquePassage(source, passage))
                        throw new Error(
                          "Choose a unique current document passage",
                        );
                      const selected = files.find((f) => f.path === origin);
                      if (!selected) throw new Error("Source unavailable");
                      const value = importedValue(
                        selected.text,
                        selected.path,
                        binding.selector,
                      );
                      if (!uniquePassage(passage, value))
                        throw new Error(
                          "The selected source value must occur once in the passage",
                        );
                      save({
                        ...data,
                        bindings: data.bindings.map((b) =>
                          b.id === binding.id
                            ? {
                                ...b,
                                targetPath: activePath,
                                passage,
                                sourcePath: origin,
                                sourceVersion: selected.text,
                                value,
                              }
                            : b,
                        ),
                      });
                    })
                  }
                />
                <details>
                  <summary>Retained source version</summary>
                  <pre>{binding.sourceVersion}</pre>
                </details>
                <button
                  disabled={binding.targetPath !== activePath}
                  onClick={() =>
                    act(() => {
                      const result = refreshedBinding(binding, files);
                      const updated = {
                        ...data,
                        bindings: data.bindings.map((b) =>
                          b.id === binding.id ? result.binding : b,
                        ),
                      };
                      if (result.search === result.replace) {
                        save(updated);
                        return;
                      }
                      propose(result.search, result.replace, updated, [
                        {
                          path: binding.sourcePath,
                          text: result.binding.sourceVersion,
                        },
                      ]);
                    })
                  }
                >
                  Preview reviewed refresh
                </button>
                <button
                  onClick={() =>
                    save({
                      ...data,
                      bindings: data.bindings.filter(
                        (b) => b.id !== binding.id,
                      ),
                    })
                  }
                >
                  Remove binding
                </button>
              </article>
            ))}
          </fieldset>
          <fieldset disabled={!canMutate}>
            <legend>Evidence lens</legend>
            <form
              aria-label="Attach evidence to a claim"
              onSubmit={(event) => {
                event.preventDefault();
                submit(event.currentTarget, "evidence");
              }}
            >
              {passageInput}
              {sourcePicker}
              <label>
                Exact source excerpt (optional until selected)
                <textarea name="excerpt" />
              </label>
              <button type="submit">Attach source version</button>
            </form>
            {data.evidence.map((item) => (
              <article key={item.id}>
                <p>
                  {evidenceStatus(item, files)} · {item.targetPath} ←{" "}
                  {item.sourcePath}
                </p>
                <blockquote>{item.passage}</blockquote>
                <RelinkForm
                  files={origins}
                  activePath={activePath}
                  onLink={(passage, origin) =>
                    act(() => {
                      if (!uniquePassage(source, passage))
                        throw new Error(
                          "Choose a unique current document passage",
                        );
                      const selected = files.find((f) => f.path === origin);
                      if (!selected) throw new Error("Source unavailable");
                      save({
                        ...data,
                        evidence: data.evidence.map((e) =>
                          e.id === item.id
                            ? {
                                ...e,
                                targetPath: activePath,
                                passage,
                                sourcePath: origin,
                                sourceVersion: selected.text,
                                excerpt: "",
                                reviewed: false,
                              }
                            : e,
                        ),
                      });
                    })
                  }
                />
                <blockquote>{item.excerpt || "No excerpt selected"}</blockquote>
                <details>
                  <summary>Retained source version</summary>
                  <pre>{item.sourceVersion}</pre>
                </details>
                <form
                  aria-label="Select source excerpt"
                  onSubmit={(event) => {
                    event.preventDefault();
                    act(() => {
                      const excerpt = String(
                        new FormData(event.currentTarget).get("excerpt") ?? "",
                      ).trim();
                      if (!excerpt || !item.sourceVersion.includes(excerpt))
                        throw new Error(
                          "Select an excerpt from the retained source version.",
                        );
                      save({
                        ...data,
                        evidence: data.evidence.map((e) =>
                          e.id === item.id
                            ? { ...e, excerpt, reviewed: false }
                            : e,
                        ),
                      });
                    });
                  }}
                >
                  <label>
                    Select source passage
                    <textarea
                      name="excerpt"
                      defaultValue={item.excerpt}
                      required
                    />
                  </label>
                  <button>Select passage</button>
                </form>
                <button
                  disabled={
                    !item.excerpt ||
                    evidenceStatus(item, files) === "Source changed" ||
                    evidenceStatus(item, files) === "Source unavailable" ||
                    evidenceStatus(item, files).startsWith("Claim") ||
                    evidenceStatus(item, files).startsWith(
                      "File path ambiguous",
                    )
                  }
                  onClick={() =>
                    save({
                      ...data,
                      evidence: data.evidence.map((e) =>
                        e.id === item.id ? { ...e, reviewed: true } : e,
                      ),
                    })
                  }
                >
                  Mark reviewed by me
                </button>
                <button
                  onClick={() =>
                    act(() => {
                      const current = files.find(
                        (f) => f.path === item.sourcePath,
                      );
                      if (!current) throw new Error("Source unavailable");
                      save({
                        ...data,
                        evidence: data.evidence.map((e) =>
                          e.id === item.id
                            ? {
                                ...e,
                                sourceVersion: current.text,
                                excerpt: "",
                                reviewed: false,
                              }
                            : e,
                        ),
                      });
                    })
                  }
                >
                  Attach current source version
                </button>
                <button
                  onClick={() =>
                    save({
                      ...data,
                      evidence: data.evidence.filter((e) => e.id !== item.id),
                    })
                  }
                >
                  Remove evidence link
                </button>
              </article>
            ))}
          </fieldset>
          <fieldset disabled={!canMutate}>
            <legend>Reviewer response desk</legend>
            <form
              aria-label="Add a reviewer comment"
              onSubmit={(event) => {
                event.preventDefault();
                submit(event.currentTarget, "review");
              }}
            >
              <label>
                Pasted reviewer comment
                <textarea name="comment" required />
              </label>
              {passageInput}
              <label>
                Proposed replacement passage
                <textarea name="revision" />
              </label>
              <label>
                Draft response
                <textarea name="response" />
              </label>
              <button type="submit">Add reviewer comment</button>
            </form>
            {data.reviews.map((item) => (
              <article key={item.id}>
                <blockquote>{item.comment}</blockquote>
                <p>
                  {item.targetPath} · {item.state} ·{" "}
                  {files.some(
                    (f) =>
                      f.path === item.targetPath &&
                      uniquePassage(f.text, item.passage),
                  )
                    ? "Passage linked"
                    : "Passage changed — relink before revision"}
                </p>
                <blockquote>{item.passage}</blockquote>
                <RelinkForm
                  activePath={activePath}
                  onLink={(passage) =>
                    act(() => {
                      if (!uniquePassage(source, passage))
                        throw new Error(
                          "Choose a unique current document passage",
                        );
                      save({
                        ...data,
                        reviews: data.reviews.map((r) =>
                          r.id === item.id
                            ? { ...r, targetPath: activePath, passage }
                            : r,
                        ),
                      });
                    })
                  }
                />
                <form
                  aria-label="Edit reviewer response"
                  key={`${item.id}:${item.response}:${item.revision}:${item.state}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const f = new FormData(event.currentTarget);
                    save({
                      ...data,
                      reviews: data.reviews.map((r) =>
                        r.id === item.id
                          ? {
                              ...r,
                              response: String(f.get("response")),
                              revision: String(f.get("revision")),
                              state: String(f.get("state")) as typeof r.state,
                            }
                          : r,
                      ),
                    });
                  }}
                >
                  <label>
                    Draft response
                    <textarea name="response" defaultValue={item.response} />
                  </label>
                  <label>
                    Proposed replacement
                    <textarea name="revision" defaultValue={item.revision} />
                  </label>
                  <label>
                    Resolution
                    <select name="state" defaultValue={item.state}>
                      <option value="open">Open</option>
                      <option value="addressed">Addressed</option>
                      <option value="declined">Declined</option>
                    </select>
                  </label>
                  <button>Save response draft</button>
                </form>
                <button
                  disabled={item.targetPath !== activePath || !item.revision}
                  onClick={() =>
                    act(() =>
                      propose(item.passage, item.revision, {
                        ...data,
                        reviews: data.reviews.map((r) =>
                          r.id === item.id ? { ...r, passage: r.revision } : r,
                        ),
                      }),
                    )
                  }
                >
                  Review proposed revision
                </button>
                <button
                  onClick={() =>
                    save({
                      ...data,
                      reviews: data.reviews.filter((r) => r.id !== item.id),
                    })
                  }
                >
                  Remove comment
                </button>
              </article>
            ))}
          </fieldset>
          <label>
            Response letter (copy or download)
            <textarea readOnly value={responseLetter(data.reviews)} />
          </label>
          <a
            download="reviewer-response.md"
            href={`data:text/markdown;charset=utf-8,${encodeURIComponent(responseLetter(data.reviews))}`}
          >
            Download response letter
          </a>
          {pending && (
            <>
              <ScratchPreview
                key={pending.id}
                input={pending.input}
                onCompiled={setCompiled}
              />
              {staleProposal && (
                <p role="status">
                  Project input changed. Reject this proposal and compile a new
                  preview.
                </p>
              )}
              <fieldset disabled={!compiled || !canMutate || staleProposal}>
                <DiffReview
                  base={pending.base}
                  next={pending.next}
                  outcome="workbench proposal — inspect compiled scratch preview"
                  onReject={() => setPending(null)}
                  onAccept={() =>
                    act(() => {
                      if (
                        !canMutate ||
                        pending.originalMetadata !== metadataText ||
                        pending.sources.some(
                          (s) =>
                            files.find((f) => f.path === s.path)?.text !==
                            s.text,
                        )
                      )
                        throw new Error(
                          "Source or metadata changed. Reject this proposal and preview again.",
                        );
                      if (
                        onAccept({
                          targetFileId: pending.targetFileId,
                          targetPath: pending.targetPath,
                          compiled,
                          expectedInputKey: pending.expectedInputKey,
                          expectedScratchInputKey:
                            pending.expectedScratchInputKey,
                          nextMetadata: JSON.stringify(
                            pending.metadata,
                            null,
                            2,
                          ),
                          baseSource: pending.base,
                          finalSource: pending.next,
                          expectedMetadata: pending.originalMetadata,
                          expectedSources: pending.sources,
                          blocks: [
                            {
                              search: pending.search,
                              replace: pending.replace,
                            },
                          ],
                        })
                      ) {
                        setPending(null);
                      } else {
                        setMessage(
                          "The document, source or metadata changed. Reject this proposal and preview again.",
                        );
                      }
                    })
                  }
                />
              </fieldset>
              {(!compiled || staleProposal) && (
                <button onClick={() => setPending(null)}>
                  Reject uncompiled proposal
                </button>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}

/** A dedicated local worker compiles only the frozen proposal, never live state. */
function ScratchPreview({
  input,
  onCompiled,
}: {
  input: CompileInput;
  onCompiled: (ok: boolean) => void;
}) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let compiler: Compiler | undefined;
    void initCompiler("local")
      .then(async (next) => {
        compiler = next;
        if (cancelled) {
          next.dispose();
          return;
        }
        const output = await next.render(input);
        if (!cancelled) {
          setResult(output);
          onCompiled(
            output.ok &&
              !output.diagnostics.some((d) => d.severity === "error"),
          );
        }
      })
      .catch((error) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      compiler?.dispose();
    };
  }, [input]);
  return (
    <section aria-label="Scratch proposal preview">
      <p>
        {error
          ? `Preview unavailable: ${error}`
          : result
            ? result.ok
              ? `Scratch compiled · ${result.pageCount ?? result.pages.length} pages`
              : "Scratch compile failed"
            : "Compiling frozen scratch proposal locally…"}
      </p>
      {result?.diagnostics.map((d, i) => (
        <p key={i}>
          {d.severity}: {d.message}
        </p>
      ))}
      {result?.ok && (
        <Preview
          svg={result.pages.map((page) => page.svg).join("\n")}
          placeholder="Scratch preview unavailable"
        />
      )}
    </section>
  );
}

function RelinkForm({
  files,
  activePath,
  onLink,
}: {
  files?: WorkbenchFile[];
  activePath: string;
  onLink: (passage: string, origin: string) => void;
}) {
  return (
    <details>
      <summary>Relink to current document or source</summary>
      <form
        aria-label="Relink document passage"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onLink(
            String(form.get("passage") ?? "").trim(),
            String(form.get("origin") ?? ""),
          );
        }}
      >
        <label>
          Replacement exact passage in {activePath}
          <textarea name="passage" required />
        </label>
        {files && (
          <label>
            Current source project file
            <select name="origin">
              {files.map((f) => (
                <option key={f.fileId} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>
        )}
        <button>Save explicit relink</button>
      </form>
    </details>
  );
}
