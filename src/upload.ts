// File uploads for create_asset, create_font and replace_font_file. Those actions only record the file and return a
// presigned Amazon S3 target ({ uploadUrl, uploadDetails }); the bytes go to S3 in a separate multipart POST.
// A snippet has no network, so it hands a file in out/ and the target to the runner (`out.upload`), which sends it
// only to a target one of those actions returned during the same run. That keeps the upload tied to a create
// call the user approved, and a snippet can't send files from out/ anywhere else.
import fs from "node:fs";
import path from "node:path";

export interface UploadTarget {
  uploadUrl: string;
  uploadDetails: Record<string, unknown>;
}

// The actions whose results hold an upload target.
export const UPLOAD_ACTIONS = new Set(["data_assets_tool.create_asset", "data_fonts_tool.create_font", "data_fonts_tool.replace_font_file"]);

const isTarget = (v: unknown): v is UploadTarget =>
  !!v &&
  typeof v === "object" &&
  typeof (v as UploadTarget).uploadUrl === "string" &&
  !!(v as UploadTarget).uploadDetails &&
  typeof (v as UploadTarget).uploadDetails === "object";

// Upload targets in a result, within its first few levels.
export function findUploadTargets(value: unknown, depth = 0): UploadTarget[] {
  if (!value || typeof value !== "object" || depth > 3) return [];
  if (isTarget(value)) return [value];
  return Object.values(value).flatMap((v) => findUploadTargets(v, depth + 1));
}

// Compares targets by content, whatever order their keys came back in.
export const targetKey = (t: UploadTarget) =>
  JSON.stringify([t.uploadUrl, Object.entries(t.uploadDetails).sort(([a], [b]) => a.localeCompare(b))]);

// Webflow returns the S3 form fields in camelCase; S3 wants its own names.
const S3_FIELDS: Record<string, string> = {
  policy: "Policy",
  successActionStatus: "success_action_status",
  contentType: "Content-Type",
  cacheControl: "Cache-Control",
};

export function s3FieldName(key: string): string {
  if (S3_FIELDS[key]) return S3_FIELDS[key];
  // xAmzSecurityToken -> X-Amz-Security-Token
  if (/^xAmz[A-Z]/.test(key)) return ["X", ...key.slice(1).split(/(?=[A-Z])/)].join("-");
  return key;
}

export function uploadForm(target: UploadTarget, bytes: Uint8Array<ArrayBuffer>, fileName: string): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.uploadDetails)) {
    if (v !== undefined && v !== null) form.append(s3FieldName(k), typeof v === "string" ? v : String(v));
  }
  const type = typeof target.uploadDetails.contentType === "string" ? target.uploadDetails.contentType : "application/octet-stream";
  // S3 ignores fields after `file`, so it goes last.
  form.append("file", new Blob([bytes], { type }), fileName);
  return form;
}

export function checkUploadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not an upload URL: ${url}`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".amazonaws.com")) {
    throw new Error(`Uploads only go to Amazon S3 over https, not ${parsed.origin}.`);
  }
}

// Upload targets returned during this run, by targetKey.
export class UploadTargets {
  private targets = new Map<string, UploadTarget>();

  record(name: string, result: unknown): void {
    if (!UPLOAD_ACTIONS.has(name)) return;
    for (const t of findUploadTargets(result)) this.targets.set(targetKey(t), t);
  }

  // Send `file` (a path in out/) to the target in `given`: a result from one of UPLOAD_ACTIONS, or its target.
  async upload(file: string, given: unknown): Promise<{ status: number; bytes: number }> {
    const [target] = findUploadTargets(given);
    if (!target) throw new Error("out.upload needs the result of create_asset, create_font or replace_font_file, or its { uploadUrl, uploadDetails }.");
    const key = targetKey(target);
    if (!this.targets.has(key)) {
      throw new Error("That upload target didn't come from create_asset, create_font or replace_font_file in this run.");
    }
    checkUploadUrl(target.uploadUrl);
    const bytes = new Uint8Array(fs.readFileSync(file));
    const res = await fetch(target.uploadUrl, { method: "POST", body: uploadForm(target, bytes, path.basename(file)) });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`The upload of ${path.basename(file)} failed: S3 answered ${res.status}${body ? `: ${body}` : ""}`);
    }
    // A presigned target takes one file.
    this.targets.delete(key);
    return { status: res.status, bytes: bytes.length };
  }
}
