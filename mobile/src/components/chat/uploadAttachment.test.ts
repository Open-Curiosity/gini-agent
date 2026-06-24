import { describe, expect, mock, test } from "bun:test";

// uploadAttachment.ts imports react-native (Flow syntax — unparseable by bun),
// expo-file-system/legacy, and @/src/api (pulls expo-file-system at import).
// Stub all three so the module graph resolves. Most tests inject deps, but one
// drives the DEFAULT-deps path (defaultDeps factory) through these spies so the
// production wiring (uploadRawSource → FileSystem → Share/Alert) is covered.
const rnShare = mock((_c: { url?: string; message?: string; title?: string }) => Promise.resolve(null));
const rnAlert = mock((_t: string, _m?: string) => {});
const fsDownload = mock((_uri: string, dest: string) => Promise.resolve({ uri: `file://${dest}` }));
const apiSource = mock((id: string) => ({ uri: `https://gw/api/uploads/${id}`, headers: { authorization: "Bearer real" } }));
mock.module("react-native", () => ({
  Platform: { OS: "ios" },
  Share: { share: rnShare },
  Alert: { alert: rnAlert }
}));
mock.module("expo-file-system/legacy", () => ({
  cacheDirectory: "/cache/",
  downloadAsync: fsDownload
}));
mock.module("@/src/api", () => ({ uploadRawSource: apiSource }));

const { openUploadAttachment, safeAttachmentName } = await import("./uploadAttachment");
type UploadAttachmentDeps = import("./uploadAttachment").UploadAttachmentDeps;

// Build a deps bundle with spies so the orchestration is exercised without the
// native FileSystem/Share/Alert bridges. Each field is overridable per test.
function makeDeps(overrides: Partial<UploadAttachmentDeps> = {}): {
  deps: UploadAttachmentDeps;
  calls: {
    download: ReturnType<typeof mock>;
    share: ReturnType<typeof mock>;
    alert: ReturnType<typeof mock>;
    source: ReturnType<typeof mock>;
  };
} {
  const download = mock((_uri: string, dest: string, _opts: { headers: Record<string, string> }) =>
    Promise.resolve({ uri: `file://${dest}` })
  );
  const share = mock((_content: { url?: string; message?: string; title?: string }) => Promise.resolve(null));
  const alert = mock((_t: string, _m: string) => {});
  const source = mock((id: string) => ({
    uri: `https://gw.example/api/uploads/${id}`,
    headers: { authorization: "Bearer t", "X-Device-Token": "dev" }
  }));
  const deps: UploadAttachmentDeps = {
    source: source as unknown as UploadAttachmentDeps["source"],
    cacheDir: "/cache/",
    download,
    share,
    platformOS: "ios",
    alert,
    ...overrides
  };
  return { deps, calls: { download, share, alert, source } };
}

describe("safeAttachmentName", () => {
  test("keeps safe chars and replaces the rest", () => {
    expect(safeAttachmentName("report.pdf")).toBe("report.pdf");
    expect(safeAttachmentName("my notes (1).md")).toBe("my_notes__1_.md");
    expect(safeAttachmentName("../../etc/passwd")).toBe(".._.._etc_passwd");
  });

  test("unsafe chars become underscores; an empty name falls back to 'file'", () => {
    // Mirrors the file-preview Download toolbar: replace then `|| "file"`, so a
    // name that maps to all-underscores stays underscores (still a valid name)
    // and only a truly empty string falls back.
    expect(safeAttachmentName("###")).toBe("___");
    expect(safeAttachmentName("")).toBe("file");
  });
});

describe("openUploadAttachment", () => {
  test("downloads with the bearer headers then shares the local file on iOS", async () => {
    const { deps, calls } = makeDeps({ platformOS: "ios" });
    await openUploadAttachment("up_1", "report.pdf", deps);
    expect(calls.source).toHaveBeenCalledWith("up_1");
    expect(calls.download).toHaveBeenCalledWith(
      "https://gw.example/api/uploads/up_1",
      "/cache/report.pdf",
      { headers: { authorization: "Bearer t", "X-Device-Token": "dev" } }
    );
    // iOS shares via { url } so the share sheet exposes Quick Look + Save to Files.
    expect(calls.share).toHaveBeenCalledWith({ url: "file:///cache/report.pdf" });
    expect(calls.alert).not.toHaveBeenCalled();
  });

  test("on Android shares via message+title (RN Share can't attach a file there)", async () => {
    const { deps, calls } = makeDeps({ platformOS: "android" });
    await openUploadAttachment("up_2", "data.csv", deps);
    expect(calls.share).toHaveBeenCalledWith({ message: "file:///cache/data.csv", title: "data.csv" });
  });

  test("a null cache dir degrades to a bare filename dest", async () => {
    const { deps, calls } = makeDeps({ cacheDir: null });
    await openUploadAttachment("up_3", "x.md", deps);
    expect(calls.download).toHaveBeenCalledWith(
      "https://gw.example/api/uploads/up_3",
      "x.md",
      { headers: { authorization: "Bearer t", "X-Device-Token": "dev" } }
    );
  });

  test("a download failure surfaces an Alert, not an unhandled rejection", async () => {
    const { deps, calls } = makeDeps({
      download: mock(() => Promise.reject(new Error("network down")))
    });
    await openUploadAttachment("up_4", "report.pdf", deps);
    expect(calls.alert).toHaveBeenCalledWith("Couldn't open attachment", "network down");
    expect(calls.share).not.toHaveBeenCalled();
  });

  test("a non-Error throw is stringified into the Alert", async () => {
    const { deps, calls } = makeDeps({
      source: mock(() => {
        throw "no creds";
      }) as unknown as UploadAttachmentDeps["source"]
    });
    await openUploadAttachment("up_5", "report.pdf", deps);
    expect(calls.alert).toHaveBeenCalledWith("Couldn't open attachment", "no creds");
  });

  test("with no injected deps, the default wiring threads through the real bridges", async () => {
    // Exercises the defaultDeps factory: uploadRawSource → FileSystem cache +
    // downloadAsync → Share, via the module-level mocks installed above.
    await openUploadAttachment("up_default", "guide.md");
    expect(apiSource).toHaveBeenCalledWith("up_default");
    expect(fsDownload).toHaveBeenCalledWith(
      "https://gw/api/uploads/up_default",
      "/cache/guide.md",
      { headers: { authorization: "Bearer real" } }
    );
    expect(rnShare).toHaveBeenCalledWith({ url: "file:///cache/guide.md" });
    expect(rnAlert).not.toHaveBeenCalled();
  });

  test("with no injected deps, a failure routes through the real Alert wrapper", async () => {
    // Drives the default-deps ERROR path so the `Alert.alert` wrapper inside
    // defaultDeps is exercised (not just the injected alert spy).
    rnAlert.mockClear();
    fsDownload.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    await openUploadAttachment("up_defaulterr", "guide.md");
    expect(rnAlert).toHaveBeenCalledWith("Couldn't open attachment", "disk full");
  });
});
