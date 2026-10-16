import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UploadTargets, checkUploadUrl, findUploadTargets, s3FieldName, uploadForm } from "./upload.ts";

const target = {
  uploadUrl: "https://example-bucket.s3.amazonaws.com/",
  uploadDetails: { acl: "public-read", key: "abc/photo.png", policy: "p", xAmzSignature: "s", successActionStatus: "201", contentType: "image/png" },
};

test("finds the target inside a result", () => {
  expect(findUploadTargets({ id: "1", upload: target })).toEqual([target]);
  expect(findUploadTargets({ id: "1" })).toEqual([]);
});

test("S3 field names", () => {
  expect(s3FieldName("policy")).toBe("Policy");
  expect(s3FieldName("xAmzSignature")).toBe("X-Amz-Signature");
  expect(s3FieldName("xAmzSecurityToken")).toBe("X-Amz-Security-Token");
  expect(s3FieldName("successActionStatus")).toBe("success_action_status");
  expect(s3FieldName("contentType")).toBe("Content-Type");
  expect(s3FieldName("key")).toBe("key");
});

test("the file goes last, typed from the details", () => {
  const form = uploadForm(target, new Uint8Array([1, 2]), "photo.png");
  const keys = [...form.keys()];
  expect(keys.at(-1)).toBe("file");
  expect(keys).toContain("X-Amz-Signature");
  expect((form.get("file") as File).type).toBe("image/png");
});

test("uploads only go to S3 over https", () => {
  expect(() => checkUploadUrl("https://example-bucket.s3.amazonaws.com/")).not.toThrow();
  expect(() => checkUploadUrl("http://example-bucket.s3.amazonaws.com/")).toThrow(/https/);
  expect(() => checkUploadUrl("https://amazonaws.com.example.net/")).toThrow(/Amazon S3/);
});

describe("UploadTargets", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-upload-")), "photo.png");
  fs.writeFileSync(file, "x");

  test("refuses a target no create call returned", async () => {
    const uploads = new UploadTargets();
    await expect(uploads.upload(file, target)).rejects.toThrow(/didn't come from/);
  });

  test("ignores targets from other actions", async () => {
    const uploads = new UploadTargets();
    uploads.record("data_cms_tool.list_collection_items", { items: [target] });
    await expect(uploads.upload(file, target)).rejects.toThrow(/didn't come from/);
  });

  test("checks the URL even for a recorded target", async () => {
    const uploads = new UploadTargets();
    const local = { ...target, uploadUrl: "http://127.0.0.1:9/" };
    uploads.record("data_assets_tool.create_asset", local);
    await expect(uploads.upload(file, local)).rejects.toThrow(/Amazon S3/);
  });

  test("needs a target", async () => {
    await expect(new UploadTargets().upload(file, { id: "1" })).rejects.toThrow(/needs the result/);
  });
});
