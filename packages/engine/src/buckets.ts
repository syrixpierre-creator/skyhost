import { Client as MinioClient } from "minio";
import { engineConfig } from "./config";
import { containerIp, ensureImage, getDocker, LABEL, names, removeContainer } from "./docker";
import { createAndStart } from "./runtime";

/**
 * S3-compatible object storage for customers. Each bucket runs in its own VersityGW (Apache-2.0 S3 gateway, POSIX
 * backend) container on the team network, with its own credentials, so buckets of different teams never share a
 * server or keys. Any S3 server that accepts root credentials through ROOT_ACCESS_KEY/ROOT_SECRET_KEY can be used.
 */
export interface BucketSpec {
  id: string;
  teamId: string;
  network: string;
  bucketName: string;
  accessKey: string;
  secretKey: string;
  isPublic: boolean;
}

export const BUCKET_IMAGE = process.env.SKYHOST_BUCKET_IMAGE ?? "versity/versitygw:v1.0.16";

export function bucketPublicHost(id: string) {
  return `s3-${id.replace(/-/g, "").slice(0, 12)}.${engineConfig().baseDomain}`;
}

async function internalClient(spec: Pick<BucketSpec, "id" | "network" | "accessKey" | "secretKey">) {
  const host = engineConfig().healthcheckMode === "dns" ? names.bucketContainer(spec.id) : await containerIp(names.bucketContainer(spec.id), spec.network);
  if (!host) throw new Error("Bucket server is not running");
  return new MinioClient({ endPoint: host, port: 9000, useSSL: false, accessKey: spec.accessKey, secretKey: spec.secretKey, region: "us-east-1" });
}

function publicPolicy(bucket: string) {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: ["*"] }, Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/*`] }],
  });
}

export async function provisionBucket(spec: BucketSpec, onLine: (l: string) => void = () => {}) {
  await ensureImage(BUCKET_IMAGE, onLine);
  const volume = names.bucketVolume(spec.id);
  await getDocker()
    .createVolume({ Name: volume, Labels: { [LABEL.managed]: "true", [LABEL.bucket]: spec.id, [LABEL.team]: spec.teamId } })
    .catch((e: Error) => {
      if (!/already exists/.test(e.message)) throw e;
    });
  await createAndStart({
    name: names.bucketContainer(spec.id),
    image: BUCKET_IMAGE,
    env: { ROOT_ACCESS_KEY: spec.accessKey, ROOT_SECRET_KEY: spec.secretKey },
    args: ["--port", ":9000", "--quiet", "posix", "/data"],
    network: spec.network,
    networkLabels: { [LABEL.team]: spec.teamId },
    aliases: [`s3-${spec.bucketName}`, `s3-${spec.bucketName}.internal`],
    labels: { [LABEL.kind]: "storage", [LABEL.bucket]: spec.id, [LABEL.team]: spec.teamId },
    cpu: 0.5,
    memoryMb: 512,
    volumes: [{ dockerVolume: volume, mountPath: "/data" }],
    restart: "always",
    // The image has no shell to chown a fresh volume, so the gateway runs as uid 0 with every capability dropped.
    capAdd: [],
    runtime: process.env.SKYHOST_DATABASE_RUNTIME ?? engineConfig().runtime,
  });
  // The gateway needs a moment before accepting requests.
  const deadline = Date.now() + 60_000;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const c = await internalClient(spec);
      if (!(await c.bucketExists(spec.bucketName))) await c.makeBucket(spec.bucketName, "us-east-1");
      await setBucketVisibility(spec, spec.isPublic);
      onLine("Bucket is ready");
      return;
    } catch (e) {
      lastErr = (e as Error).message;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Bucket server did not start: ${lastErr}`);
}

export async function setBucketVisibility(spec: Pick<BucketSpec, "id" | "network" | "accessKey" | "secretKey" | "bucketName">, isPublic: boolean) {
  const c = await internalClient(spec);
  // S3 answers 204 (AWS, MinIO) or 200 (VersityGW); the client's setBucketPolicy only accepts 204.
  await c.makeRequestAsyncOmit({ method: isPublic ? "PUT" : "DELETE", bucketName: spec.bucketName, query: "policy" }, isPublic ? publicPolicy(spec.bucketName) : "", [200, 204], "");
}

export async function bucketUsageBytes(spec: Pick<BucketSpec, "id" | "network" | "accessKey" | "secretKey" | "bucketName">): Promise<number> {
  const c = await internalClient(spec);
  let total = 0;
  const stream = c.listObjectsV2(spec.bucketName, "", true);
  for await (const obj of stream as AsyncIterable<{ size?: number }>) total += obj.size ?? 0;
  return total;
}

/** Presigned URL using the public endpoint. Signing is local: no request is made. */
export async function presignUrl(spec: Pick<BucketSpec, "id" | "accessKey" | "secretKey" | "bucketName">, objectKey: string, method: "GET" | "PUT", expiresSeconds: number) {
  const cfg = engineConfig();
  const client = new MinioClient({ endPoint: bucketPublicHost(spec.id), port: cfg.publicScheme === "https" ? 443 : 80, useSSL: cfg.publicScheme === "https", accessKey: spec.accessKey, secretKey: spec.secretKey, region: "us-east-1" });
  return client.presignedUrl(method, spec.bucketName, objectKey, Math.min(expiresSeconds, 7 * 24 * 3600));
}

export async function deleteBucket(id: string) {
  await removeContainer(names.bucketContainer(id), { graceSeconds: 5 });
  await getDocker().getVolume(names.bucketVolume(id)).remove().catch(() => {});
}
