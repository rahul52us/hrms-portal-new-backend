import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import axios, { AxiosResponse } from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import { Request, Response } from "express";
import AdmZip from "adm-zip";
import { Readable } from "stream";
import { v4 as uuidv4 } from "uuid";

const LOCAL_SCORM_ROOT = process.env.VERCEL
  ? path.join(os.tmpdir(), "hrms-backend", "public", "uploads", "courses")
  : path.join(process.cwd(), "public", "uploads", "courses");
const TEMP_UPLOAD_ROOT = path.join(os.tmpdir(), "hrms-backend", "uploads", "temp");
const TEMP_EXTRACT_ROOT = path.join(TEMP_UPLOAD_ROOT, "scorm-extract");
const TEMP_CHUNK_ROOT = path.join(TEMP_UPLOAD_ROOT, "chunked-scorm");

const AWS_REGION = process.env.AWS_REGION || "";
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || "";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";
const AWS_SCORM_PREFIX = normalizeStoragePrefix(process.env.AWS_SCORM_PREFIX || "scorm/");
const AWS_VIDEOS_PREFIX = normalizeStoragePrefix(process.env.AWS_VIDEOS_PREFIX || "videos/");
const AWS_CHUNK_PREFIX = normalizeStoragePrefix(process.env.AWS_CHUNK_PREFIX || "_chunk_uploads/");

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "") || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_SCORM_BUCKET = process.env.SUPABASE_SCORM_BUCKET || "scorm-packages";
const SUPABASE_STORAGE_BASE_URL = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1` : "";
const SUPABASE_CHUNK_PREFIX = "_chunk_uploads";
const DEFAULT_SUPABASE_UPLOAD_CONCURRENCY = 8;

let bucketEnsurePromise: Promise<void> | null = null;
let s3Client: S3Client | null = null;
const scormSlideMetadataCache = new Map<string, Promise<ScormSlideMetadata | null>>();
const scormOcrTextCache = new Map<string, Promise<string>>();
let scormOcrWorkerPromise: Promise<any> | null = null;

type OcrBudget = {
  remaining: number;
};

type CourseLike = {
  scormFilePath?: string;
  curriculum?: {
    modules?: Array<{
      studyMaterial?: Array<{
        previewUrl?: string;
      }> | null;
      sections?: Array<{
        content?: {
          kind?: string;
          previewUrl?: string;
        } | null;
        studyMaterial?: Array<{
          previewUrl?: string;
        }> | null;
      }>;
    }>;
  };
};

ensureDirectory(TEMP_UPLOAD_ROOT);
ensureDirectory(TEMP_EXTRACT_ROOT);
ensureDirectory(TEMP_CHUNK_ROOT);

export type ChunkedAssetUpload = {
  uploadId: string;
  fileName: string;
  totalChunks: number;
  contentType?: string;
  sizeInBytes?: number;
};

export type ChunkedScormUpload = ChunkedAssetUpload;

export type ScormSlideMetadata = {
  totalSlides: number | null;
  sourceAssetPath: string | null;
  questions: ScormQuestionMetadata[];
};

export type ScormQuestionChoiceMetadata = {
  index: number;
  id: string;
  text: string;
  isCorrect: boolean;
};

export type ScormQuestionMetadata = {
  questionId: string;
  interactionId: string;
  interactionIds: string[];
  slideNumber: number | null;
  quizIndex: number | null;
  questionIndex: number;
  type: string;
  question: string;
  questionPrompt?: string;
  choices: ScormQuestionChoiceMetadata[];
  correctResponses: string[];
  imageAssetPaths: string[];
  sourceAssetPath: string;
};

function ensureDirectory(directoryPath: string) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function normalizeStoragePrefix(value: string) {
  const normalizedValue = String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");

  if (!normalizedValue) {
    return "";
  }

  return normalizedValue.endsWith("/") ? normalizedValue : `${normalizedValue}/`;
}

function isInsideDirectory(parentDir: string, targetPath: string) {
  const relativePath = path.relative(parentDir, targetPath);
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function removeDirectoryIfSafe(directoryPath: string, allowedRoot: string) {
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const resolvedAllowedRoot = path.resolve(allowedRoot);

  if (!isInsideDirectory(resolvedAllowedRoot, resolvedDirectoryPath)) {
    throw new Error(`Refusing to delete path outside allowed root: ${resolvedDirectoryPath}`);
  }

  if (fs.existsSync(resolvedDirectoryPath)) {
    fs.rmSync(resolvedDirectoryPath, { recursive: true, force: true });
  }
}

function cleanupFileIfPresent(filePath: string) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function normalizeCourseAssetPath(rawPath: string) {
  const strippedPath = rawPath.replace(/^\/+/, "");
  const normalizedPath = path.posix.normalize(strippedPath);

  if (!normalizedPath || normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error("Invalid SCORM asset path");
  }

  return normalizedPath;
}

function encodeObjectPath(objectPath: string) {
  return objectPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeChunkUploadId(uploadId: string) {
  const normalizedUploadId = String(uploadId || "").trim();

  if (!/^[A-Za-z0-9_-]+$/.test(normalizedUploadId)) {
    throw new Error("Invalid SCORM upload id");
  }

  return normalizedUploadId;
}

function getChunkObjectPath(uploadId: string, chunkIndex: number) {
  return `${SUPABASE_CHUNK_PREFIX}/${normalizeChunkUploadId(uploadId)}/${chunkIndex}.part`;
}

type RemoteStorageKind = "scorm" | "asset" | "chunk";

function getRemoteStorageKindForPrefix(prefix: string): Exclude<RemoteStorageKind, "chunk"> {
  return prefix.startsWith("asset-") ? "asset" : "scorm";
}

function buildS3ObjectKey(objectPath: string, storageKind: RemoteStorageKind) {
  const normalizedObjectPath = objectPath.replace(/^\/+/, "");
  const prefix =
    storageKind === "scorm"
      ? AWS_SCORM_PREFIX
      : storageKind === "asset"
        ? AWS_VIDEOS_PREFIX
        : AWS_CHUNK_PREFIX;

  return `${prefix}${normalizedObjectPath}`;
}

function getLocalChunkDirectory(uploadId: string) {
  return path.join(TEMP_CHUNK_ROOT, normalizeChunkUploadId(uploadId));
}

function getLocalChunkPath(uploadId: string, chunkIndex: number) {
  return path.join(getLocalChunkDirectory(uploadId), `${chunkIndex}.part`);
}

function sanitizeFileName(fileName: string) {
  const normalizedFileName = path.basename(fileName || "package.zip");
  return normalizedFileName.replace(/[^A-Za-z0-9._-]/g, "_");
}

function getSupabaseAuthHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

function isAwsS3Configured() {
  return Boolean(AWS_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
}

function isSupabaseStorageConfigured() {
  return Boolean(SUPABASE_STORAGE_BASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function hasRemoteCourseStorage() {
  return isAwsS3Configured() || isSupabaseStorageConfigured();
}

function getRemoteStorageUploadConcurrency() {
  const requestedConcurrency = Number(
    process.env.SCORM_SUPABASE_UPLOAD_CONCURRENCY || DEFAULT_SUPABASE_UPLOAD_CONCURRENCY
  );

  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    return DEFAULT_SUPABASE_UPLOAD_CONCURRENCY;
  }

  return Math.min(requestedConcurrency, 16);
}

function getS3Client() {
  if (!isAwsS3Configured()) {
    throw new Error("AWS S3 is not configured. Set AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.");
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  return s3Client;
}

function getContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".eot":
      return "application/vnd.ms-fontobject";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function walkDirectoryFiles(directoryPath: string): string[] {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDirectoryFiles(fullPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function findLaunchFile(directoryPath: string): string | null {
  const directoryEntries = fs.readdirSync(directoryPath);
  const preferredLaunchFiles = ["index_lms.html", "story.html", "index.html", "story_html5.html"];

  for (const fileName of preferredLaunchFiles) {
    if (directoryEntries.includes(fileName)) {
      return path.join(directoryPath, fileName);
    }
  }

  for (const fileName of directoryEntries) {
    if (fileName.endsWith(".html") && !fileName.startsWith("._")) {
      return path.join(directoryPath, fileName);
    }
  }

  for (const entryName of directoryEntries) {
    const fullPath = path.join(directoryPath, entryName);
    if (fs.statSync(fullPath).isDirectory()) {
      const nestedLaunchFile = findLaunchFile(fullPath);
      if (nestedLaunchFile) {
        return nestedLaunchFile;
      }
    }
  }

  return null;
}

async function ensureSupabaseBucket() {
  if (!isSupabaseStorageConfigured()) {
    throw new Error("Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  if (!bucketEnsurePromise) {
    bucketEnsurePromise = (async () => {
      try {
        await axios.post(
          `${SUPABASE_STORAGE_BASE_URL}/bucket`,
          {
            id: SUPABASE_SCORM_BUCKET,
            name: SUPABASE_SCORM_BUCKET,
            public: false,
          },
          {
            headers: {
              ...getSupabaseAuthHeaders(),
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        ).then((response) => {
          if (response.status >= 200 && response.status < 300) {
            return;
          }

          if (response.status === 400 || response.status === 409) {
            return;
          }

          throw new Error(`Failed to ensure Supabase bucket: ${response.status}`);
        });
      } catch (error) {
        bucketEnsurePromise = null;
        throw error;
      }
    })();
  }

  await bucketEnsurePromise;
}

async function uploadBufferToS3(
  fileBuffer: Buffer,
  objectPath: string,
  contentType: string,
  storageKind: RemoteStorageKind
) {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: buildS3ObjectKey(objectPath, storageKind),
      Body: fileBuffer,
      ContentType: contentType,
    })
  );
}

async function uploadBufferToSupabase(fileBuffer: Buffer, objectPath: string, contentType: string, upsert = false) {
  await ensureSupabaseBucket();

  const response = await axios.post(
    `${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}/${encodeObjectPath(objectPath)}`,
    fileBuffer,
    {
      headers: {
        ...getSupabaseAuthHeaders(),
        "Content-Type": contentType,
        "x-upsert": upsert ? "true" : "false",
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to upload ${objectPath} to Supabase Storage: ${response.status}`);
  }
}

async function uploadFileToS3(filePath: string, objectPath: string, storageKind: Exclude<RemoteStorageKind, "chunk">) {
  const s3 = getS3Client();
  const fileStats = fs.statSync(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: buildS3ObjectKey(objectPath, storageKind),
      Body: fileBuffer,
      ContentType: getContentType(filePath),
      ContentLength: fileStats.size,
    })
  );
}

async function listS3ObjectKeys(prefix: string, storageKind: RemoteStorageKind) {
  const s3 = getS3Client();
  const objectPrefix = buildS3ObjectKey(prefix, storageKind);
  const objectKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: AWS_S3_BUCKET,
        Prefix: objectPrefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const objectRecord of result.Contents || []) {
      if (objectRecord.Key) {
        objectKeys.push(objectRecord.Key);
      }
    }

    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return objectKeys;
}

async function deleteS3ObjectKeys(objectKeys: string[]) {
  if (objectKeys.length === 0) {
    return;
  }

  const s3 = getS3Client();

  for (let index = 0; index < objectKeys.length; index += 1000) {
    const batch = objectKeys.slice(index, index + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: AWS_S3_BUCKET,
        Delete: {
          Objects: batch.map((objectKey) => ({ Key: objectKey })),
          Quiet: true,
        },
      })
    );
  }
}

async function deleteS3Prefixes(prefixes: string[], storageKind: RemoteStorageKind) {
  if (!isAwsS3Configured() || prefixes.length === 0) {
    return;
  }

  for (const prefix of prefixes) {
    const objectKeys = await listS3ObjectKeys(prefix, storageKind);
    await deleteS3ObjectKeys(objectKeys);
  }
}

function toNodeReadable(body: any) {
  if (!body) {
    return null;
  }

  if (body instanceof Readable) {
    return body;
  }

  if (typeof body.pipe === "function") {
    return body as Readable;
  }

  if (typeof body.transformToWebStream === "function" && typeof (Readable as any).fromWeb === "function") {
    return (Readable as any).fromWeb(body.transformToWebStream());
  }

  return null;
}

type ParsedByteRange = {
  start: number;
  end: number;
  contentLength: number;
  contentRange: string;
};

function parseByteRange(rangeHeader: string | undefined, totalSize: number): ParsedByteRange | null {
  const normalizedRange = String(rangeHeader || "").trim();
  if (!normalizedRange || !/^bytes=/.test(normalizedRange) || totalSize <= 0) {
    return null;
  }

  const [startTokenRaw, endTokenRaw] = normalizedRange.replace(/^bytes=/, "").split(",", 1)[0].split("-", 2);
  const startToken = String(startTokenRaw || "").trim();
  const endToken = String(endTokenRaw || "").trim();

  let start = 0;
  let end = totalSize - 1;

  if (startToken === "" && endToken === "") {
    return null;
  }

  if (startToken === "") {
    const suffixLength = Number(endToken);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }

    start = Math.max(totalSize - suffixLength, 0);
  } else {
    start = Number(startToken);
    if (!Number.isInteger(start) || start < 0 || start >= totalSize) {
      return null;
    }
  }

  if (endToken !== "") {
    end = Number(endToken);
    if (!Number.isInteger(end) || end < start) {
      return null;
    }
  }

  end = Math.min(end, totalSize - 1);

  return {
    start,
    end,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
  };
}

async function streamBodyToBuffer(body: any): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body.transformToByteArray === "function") {
    const byteArray = await body.transformToByteArray();
    return Buffer.from(byteArray);
  }

  if (typeof body.transformToString === "function") {
    const contents = await body.transformToString();
    return Buffer.from(contents, "utf8");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<any>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function readPositiveInteger(value: unknown) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}

function extractSlideCountFromText(fileContents: string) {
  const normalizedContents = String(fileContents || "");
  if (!normalizedContents) {
    return null;
  }

  const patterns = [
    /["']slidesToView["']\s*[:=]\s*(\d+)/i,
    /\bslidesToView\s*[:=]\s*(\d+)/i,
    /["']totalSlides["']\s*[:=]\s*(\d+)/i,
    /\btotalSlides?\s*[:=]\s*(\d+)/i,
    /["']slideCount["']\s*[:=]\s*(\d+)/i,
    /\bslideCount\s*[:=]\s*(\d+)/i,
    /["']totalPages["']\s*[:=]\s*(\d+)/i,
    /\btotalPages?\s*[:=]\s*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedContents.match(pattern);
    const candidateValue = readPositiveInteger(match?.[1]);
    if (candidateValue !== null) {
      return candidateValue;
    }
  }

  return null;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, codePoint) => {
      const numericCodePoint = Number(codePoint);
      return Number.isFinite(numericCodePoint) ? String.fromCharCode(numericCodePoint) : " ";
    });
}

function normalizeScormQuestionText(value: unknown) {
  return decodeHtmlEntities(String(value ?? ""))
    .replace(/\u200B/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMetadataIdentifier(value: unknown) {
  return String(value ?? "").trim();
}

function isUsefulQuestionText(value: unknown) {
  const normalizedValue = normalizeScormQuestionText(value);
  if (normalizedValue.length < 3) {
    return false;
  }

  if (/^(direction|content|default|none|solid|gradient|vertical|middle|left|right|center)$/i.test(normalizedValue)) {
    return false;
  }

  if (/^(rectangle|roundedrectangle|ellipse|textbox|triangle|freeform|shape|image|line)$/i.test(normalizedValue)) {
    return false;
  }

  if (/^(picture|text box)\s*\d*$/i.test(normalizedValue)) {
    return false;
  }

  if (/^[-\d.,]+$/.test(normalizedValue)) {
    return false;
  }

  return /[A-Za-z]/.test(normalizedValue);
}

function isTitleOnlyQuestionText(value: unknown) {
  const normalizedValue = normalizeScormQuestionText(value).toLowerCase();
  return normalizedValue === "time for reflection" || normalizedValue === "customer centricity assessment";
}

function uniqueNormalizedStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeScormQuestionText(value)).filter(Boolean)));
}

function extractRichText(value: any) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const candidates: string[] = [];

  if (Array.isArray(value.d)) {
    candidates.push(...value.d.map((entry: unknown) => normalizeScormQuestionText(entry)));
  }

  if (value.a) {
    candidates.push(normalizeScormQuestionText(value.a));
  }

  if (value.h) {
    candidates.push(normalizeScormQuestionText(value.h));
  }

  if (value.v && typeof value.v === "object") {
    candidates.push(extractRichText(value.v));
  }

  return uniqueNormalizedStrings(candidates)
    .filter(isUsefulQuestionText)
    .sort((left, right) => right.length - left.length)[0] || "";
}

function extractISpringQuestionDirectText(slide: Record<string, any>) {
  return extractRichText(slide.D);
}

function extractISpringObjectPromptTexts(slide: Record<string, any>) {
  const objects = Array.isArray(slide?.a?.o) ? slide.a.o : [];
  const candidates: string[] = [];

  for (const objectEntry of objects) {
    if (!objectEntry || typeof objectEntry !== "object") {
      continue;
    }

    const objectName = normalizeScormQuestionText(objectEntry.I).toLowerCase();
    if (objectName === "direction" || objectName === "content") {
      continue;
    }

    candidates.push(extractRichText(objectEntry.rt));
    candidates.push(extractRichText(objectEntry.t));
  }

  return uniqueNormalizedStrings(candidates).filter(isUsefulQuestionText);
}

function collectStorageImageReferences(value: unknown, refs = new Set<string>()) {
  if (!value) {
    return refs;
  }

  if (typeof value === "string") {
    if (/^storage:\/\/images\//i.test(value)) {
      refs.add(value);
    }
    return refs;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectStorageImageReferences(entry, refs));
    return refs;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((entry) => collectStorageImageReferences(entry, refs));
  }

  return refs;
}

function buildCourseAssetPath(...segments: string[]) {
  return `/${path.posix.join(...segments.map((segment) => segment.replace(/^\/+|\/+$/g, "")))}`;
}

export function resolveExistingAssetPaths(options: {
  storageReference: string;
  quizAssetPath: string;
}): string[] {
  const normalizedQuizPath = normalizeCourseAssetPath(options.quizAssetPath);
  const quizDirectory = path.posix.dirname(normalizedQuizPath);
  const quizBaseName = path.posix.basename(normalizedQuizPath, path.posix.extname(normalizedQuizPath));
  
  const storagePath = options.storageReference.replace(/^storage:\/\//i, "").replace(/^\/+/, "");
  const searchBaseName = path.posix.parse(path.posix.basename(storagePath)).name;

  const candidateDirs = [
    path.posix.join(quizDirectory, quizBaseName, "images"),
    path.posix.join(quizDirectory, quizBaseName),
    path.posix.join(quizDirectory, "images"),
    quizDirectory,
  ];

  const actualPaths = new Set<string>();

  for (const dir of candidateDirs) {
    const localDir = path.join(LOCAL_SCORM_ROOT, ...dir.split("/"));
    if (!fs.existsSync(localDir)) continue;

    try {
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        
        const fileName = entry.name;
        const fileBaseName = path.parse(fileName).name;
        
        if (fileBaseName === searchBaseName) {
          actualPaths.add(buildCourseAssetPath(dir, fileName));
        }
      }
    } catch (err) {
      continue;
    }
    
    if (actualPaths.size > 0) {
      break;
    }
  }

  return Array.from(actualPaths);
}

export function isLikelyInternalId(text: string): boolean {
  const normalized = String(text || "").trim();
  if (!normalized) return true;
  
  if (!normalized.includes(" ") && normalized.length >= 12) {
    if (/^[a-z0-9]+-[a-z0-9]+$/i.test(normalized)) return true;
    if (/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i.test(normalized)) return true;
    if (/^[a-z0-9_]+$/.test(normalized)) return true;
  }
  return false;
}

export function inferQuizSlideNumberFromManifest(manifestXml: string): Record<string, number> {
  const mapping: Record<string, number> = {};
  if (!manifestXml) return mapping;

  let currentSlideNumber: number | null = null;
  const hrefRegex = /href="([^"]+)"/ig;
  let match;

  while ((match = hrefRegex.exec(manifestXml)) !== null) {
    const href = match[1];
    const thmbMatch = href.match(/thmb(\d+)\.jpg/i);
    if (thmbMatch) {
      currentSlideNumber = parseInt(thmbMatch[1], 10);
      continue;
    }

    const quizMatch = href.match(/(res\/data\/quiz\d+\.js)/i);
    if (quizMatch && currentSlideNumber !== null) {
      mapping[quizMatch[1]] = currentSlideNumber;
    }
  }

  return mapping;
}

function getScormQuestionOcrLimit() {
  const configuredLimit = Number(process.env.SCORM_QUESTION_OCR_MAX_IMAGES || 12);
  if (!Number.isInteger(configuredLimit) || configuredLimit < 0) {
    return 12;
  }

  return Math.min(configuredLimit, 40);
}

function isScormQuestionOcrEnabled() {
  return process.env.SCORM_QUESTION_OCR_ENABLED !== "false" && getScormQuestionOcrLimit() > 0;
}

async function getScormOcrWorker() {
  if (!scormOcrWorkerPromise) {
    scormOcrWorkerPromise = (async () => {
      const { createWorker, PSM } = require("tesseract.js");
      const worker = await createWorker(process.env.SCORM_OCR_LANG || "eng", 1, {
        cachePath: path.join(os.tmpdir(), "hrms-backend", "tesseract-cache"),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
      });
      return worker;
    })().catch((error) => {
      scormOcrWorkerPromise = null;
      throw error;
    });
  }

  return scormOcrWorkerPromise;
}

function cleanupOcrLine(value: string) {
  return normalizeScormQuestionText(value)
    .replace(/^[^\w]+/, "")
    .replace(/[|{}\[\]]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOcrLines(ocrText: string) {
  const lines = String(ocrText || "")
    .split(/\r?\n/)
    .map(cleanupOcrLine)
    .filter((line) => line.length > 1)
    .filter((line) => !/^hinduj?a\s+leyland\s+finan/i.test(line))
    .filter((line) => !/^[o0aI]$/i.test(line));

  return uniqueNormalizedStrings(lines).filter(isUsefulQuestionText);
}

function extractQuestionFromOcrText(ocrText: string) {
  const lines = getOcrLines(ocrText);
  const explicitQuestionIndex = lines.findIndex((line) => /\?$/.test(line) && line.length > 8);
  if (explicitQuestionIndex >= 0) {
    const explicitQuestion = lines[explicitQuestionIndex].replace(/^\?\s*/, "").trim();
    const previousLine = lines[explicitQuestionIndex - 1] || "";
    if (
      previousLine &&
      !/^(?:[A-Da-d]|\d+)[).:\-\s]+/.test(previousLine) &&
      /\b(what|why|which|how|when|where|does|is|are|can|should|would|customer|proactive|foundation)\b/i.test(previousLine)
    ) {
      return `${previousLine.replace(/^\?\s*/, "").trim()} ${explicitQuestion}`.replace(/\s+/g, " ").trim();
    }

    return explicitQuestion;
  }

  const questionLikeLine = lines.find((line) =>
    /\b(what|why|which|how|when|where|does|is|are|can|should|would)\b/i.test(line) && line.length > 12
  );

  return questionLikeLine || "";
}

function extractChoicesFromOcrText(ocrText: string) {
  const lines = getOcrLines(ocrText);
  const choices: string[] = [];
  let currentChoice = "";

  for (const line of lines) {
    const numberedMatch = line.match(/^(?:[A-Da-d]|\d+)[).:\-\s]+(.+)$/);
    if (numberedMatch?.[1]) {
      if (currentChoice) {
        choices.push(currentChoice);
      }
      currentChoice = numberedMatch[1].trim();
      continue;
    }

    if (currentChoice && !/\?$/.test(line)) {
      currentChoice = `${currentChoice} ${line}`.replace(/\s+/g, " ").trim();
    }
  }

  if (currentChoice) {
    choices.push(currentChoice);
  }

  return uniqueNormalizedStrings(choices).filter((choice) => choice.length > 2);
}

function parseISpringQuizSlideMap(indexContents: string) {
  const keyMatch = indexContents.match(/\bquizzes\s*:/i);
  if (keyMatch?.index == null) {
    return [];
  }

  const arrayStart = indexContents.indexOf("[", keyMatch.index);
  if (arrayStart < 0) {
    return [];
  }

  let depth = 0;
  for (let index = arrayStart; index < indexContents.length; index += 1) {
    const character = indexContents[index];
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        const literal = indexContents.slice(arrayStart, index + 1);
        try {
          const parsed = JSON.parse(literal);
          return Array.isArray(parsed)
            ? parsed
                .map((entry: unknown) => (Array.isArray(entry) ? readPositiveInteger(entry[0]) : null))
                .filter((entry): entry is number => entry !== null)
            : [];
        } catch (error) {
          return [];
        }
      }
    }
  }

  return [];
}

function parseISpringQuizPayload(quizContents: string) {
  const quizInfoMatch = quizContents.match(/var\s+quizInfo\s*=\s*"([^"]+)"/i);
  if (!quizInfoMatch?.[1]) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(quizInfoMatch[1], "base64").toString("utf8"));
  } catch (error) {
    return null;
  }
}

function getISpringQuestionSlides(quizPayload: any) {
  const groups = Array.isArray(quizPayload?.d?.sl?.g) ? quizPayload.d.sl.g : [];
  const slides: Record<string, any>[] = [];

  groups.forEach((group: any) => {
    if (Array.isArray(group?.S)) {
      group.S.forEach((slide: any) => {
        if (slide && typeof slide === "object") {
          slides.push(slide);
        }
      });
    }
  });

  return slides;
}

function isTrackableISpringQuestion(slide: Record<string, any>) {
  const questionId = normalizeMetadataIdentifier(slide.i);
  const type = normalizeScormQuestionText(slide.tp).toLowerCase();
  if (!questionId || type === "infoslide") {
    return false;
  }

  return Boolean(type || Array.isArray(slide?.C?.chs));
}

function extractISpringChoices(slide: Record<string, any>, ocrChoices: string[]): ScormQuestionChoiceMetadata[] {
  const rawChoices = Array.isArray(slide?.C?.chs) ? slide.C.chs : [];
  const usableOcrChoices = ocrChoices.length >= rawChoices.length ? ocrChoices : [];

  return rawChoices.map((choice: any, index: number) => {
    const richText = extractRichText(choice?.t);
    return {
      index,
      id: normalizeMetadataIdentifier(choice?.i),
      text: isUsefulQuestionText(richText) ? richText : normalizeScormQuestionText(usableOcrChoices[index]),
      isCorrect: Boolean(choice?.c),
    } satisfies ScormQuestionChoiceMetadata;
  });
}

function buildUnderscoredQuestionAlias(value: string) {
  return normalizeScormQuestionText(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildISpringInteractionAliases(options: {
  slideNumber: number | null;
  questionId: string;
  questionIndex: number;
  directQuestionText: string;
  finalQuestionText: string;
}) {
  const aliases = new Set<string>();
  const slideNumbers = new Set<number>();

  if (options.slideNumber !== null) {
    slideNumbers.add(options.slideNumber);
    if (options.slideNumber > 1) {
      slideNumbers.add(options.slideNumber - 1);
    }
    if (options.questionIndex > 0) {
      slideNumbers.add(options.slideNumber + options.questionIndex);
    }
  }

  if (!slideNumbers.size) {
    aliases.add(options.questionId);
  }

  const readableTails = uniqueNormalizedStrings([options.directQuestionText, options.finalQuestionText])
    .map(buildUnderscoredQuestionAlias)
    .filter(Boolean);

  slideNumbers.forEach((slideNumber) => {
    aliases.add(`Slide${slideNumber}_Q_${options.questionId}`);
    aliases.add(`Slide${slideNumber}_Q_${options.questionId}_`);
    readableTails.forEach((tail) => {
      aliases.add(`Slide${slideNumber}_Q_${options.questionId}_${tail}`);
      aliases.add(`Slide${slideNumber}_Q_${options.questionId}_${tail}_`);
    });
  });

  return Array.from(aliases);
}

async function readCourseAssetBuffer(assetPath: string) {
  const normalizedAssetPath = normalizeCourseAssetPath(assetPath);
  const localFilePath = path.join(LOCAL_SCORM_ROOT, ...normalizedAssetPath.split("/"));

  if (
    isInsideDirectory(LOCAL_SCORM_ROOT, localFilePath) &&
    fs.existsSync(localFilePath) &&
    fs.statSync(localFilePath).isFile()
  ) {
    return fs.readFileSync(localFilePath);
  }

  if (!isSupabaseStorageConfigured()) {
    return null;
  }

  const upstreamResponse = await axios.get(
    `${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}/${encodeObjectPath(normalizedAssetPath)}`,
    {
      headers: getSupabaseAuthHeaders(),
      responseType: "arraybuffer",
      validateStatus: () => true,
    }
  );

  if (upstreamResponse.status === 404) {
    return null;
  }

  if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
    throw new Error(
      `Failed to fetch SCORM image metadata asset from Supabase Storage: ${upstreamResponse.status} for ${normalizedAssetPath}`
    );
  }

  return Buffer.from(upstreamResponse.data);
}

async function readOcrTextForAsset(assetPath: string) {
  const normalizedAssetPath = normalizeCourseAssetPath(assetPath);
  const cachedResult = scormOcrTextCache.get(normalizedAssetPath);
  if (cachedResult) {
    return cachedResult;
  }

  const ocrPromise = (async () => {
    const assetBuffer = await readCourseAssetBuffer(normalizedAssetPath);
    if (!assetBuffer) {
      return "";
    }

    const worker = await getScormOcrWorker();
    const { PSM } = require("tesseract.js");
    const pageSegmentationModes = [PSM.AUTO, PSM.SINGLE_BLOCK];
    const recognizedTexts: string[] = [];

    for (const pageSegmentationMode of pageSegmentationModes) {
      await worker.setParameters({
        tessedit_pageseg_mode: pageSegmentationMode,
      });
      const result = await worker.recognize(assetBuffer);
      const recognizedText = String(result?.data?.text || "");
      if (recognizedText.trim()) {
        recognizedTexts.push(recognizedText);
      }
    }

    return recognizedTexts.join("\n");
  })().catch((error) => {
    console.warn(`Unable to OCR SCORM question image ${normalizedAssetPath}.`, error);
    return "";
  });

  scormOcrTextCache.set(normalizedAssetPath, ocrPromise);
  return ocrPromise;
}

async function extractOcrQuestionSupplement(imageAssetPaths: string[], budget: OcrBudget) {
  if (!isScormQuestionOcrEnabled() || budget.remaining <= 0 || imageAssetPaths.length === 0) {
    return {
      question: "",
      choices: [] as string[],
    };
  }

  const ocrTexts: string[] = [];
  for (const imageAssetPath of imageAssetPaths) {
    if (budget.remaining <= 0) {
      break;
    }

    const ocrText = await readOcrTextForAsset(imageAssetPath);
    if (ocrText) {
      budget.remaining -= 1;
      ocrTexts.push(ocrText);
      const combinedText = ocrTexts.join("\n");
      if (extractQuestionFromOcrText(combinedText) || extractChoicesFromOcrText(combinedText).length) {
        break;
      }
    }
  }

  const combinedText = ocrTexts.join("\n");
  return {
    question: extractQuestionFromOcrText(combinedText),
    choices: extractChoicesFromOcrText(combinedText),
  };
}

function chooseBestQuestionText(directQuestionText: string, objectPromptTexts: string[], ocrQuestionText: string) {
  const promptText = objectPromptTexts.sort((left, right) => right.length - left.length)[0] || "";
  if (promptText && (!directQuestionText || isTitleOnlyQuestionText(directQuestionText) || promptText.length > directQuestionText.length + 12)) {
    return promptText;
  }

  if (isUsefulQuestionText(directQuestionText) && !isTitleOnlyQuestionText(directQuestionText)) {
    return directQuestionText;
  }

  if (isUsefulQuestionText(ocrQuestionText)) {
    return ocrQuestionText;
  }

  return directQuestionText || promptText || "";
}

export function chooseQuestionPrompt(directQuestionText: string, objectPromptTexts: string[], questionTitle: string) {
  const ignoreList = new Set([
    "submit", "continue", "retry", "correct", "incorrect", "your answer", "type your answer here"
  ]);
  const titleLower = normalizeScormQuestionText(questionTitle).toLowerCase();
  
  const validPrompts = objectPromptTexts.filter(text => {
    const lower = text.toLowerCase();
    return !ignoreList.has(lower) && lower !== titleLower && isUsefulQuestionText(text);
  });

  if (validPrompts.length > 0) {
    return validPrompts.sort((a, b) => b.length - a.length)[0];
  }

  return "";
}

function buildQuestionDuplicateKey(value: string) {
  return normalizeScormQuestionText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function hasTextChoices(metadata: ScormQuestionMetadata) {
  return metadata.choices.length > 0 && metadata.choices.every((choice) => isUsefulQuestionText(choice.text));
}

function enrichImageQuestionChoicesFromTextDuplicates(metadata: ScormQuestionMetadata[]) {
  const directQuestionChoices = new Map<string, ScormQuestionMetadata>();

  metadata.forEach((entry) => {
    const key = buildQuestionDuplicateKey(entry.question);
    if (key && entry.imageAssetPaths.length === 0 && hasTextChoices(entry)) {
      directQuestionChoices.set(key, entry);
    }
  });

  return metadata.map((entry) => {
    const key = buildQuestionDuplicateKey(entry.question);
    const duplicateEntry = key ? directQuestionChoices.get(key) : undefined;
    if (!duplicateEntry || entry.imageAssetPaths.length === 0 || !entry.choices.length) {
      return entry;
    }

    const choices = entry.choices.map((choice, index) => ({
      ...choice,
      text: normalizeScormQuestionText(duplicateEntry.choices[index]?.text) || choice.text,
    }));
    const correctResponses = uniqueNormalizedStrings(
      choices.filter((choice) => choice.isCorrect).map((choice) => choice.text || choice.id || String(choice.index))
    );

    return {
      ...entry,
      choices,
      correctResponses,
    };
  });
}

async function buildISpringQuestionMetadata(options: {
  quizAssetPath: string;
  quizIndex: number;
  quizStartSlide: number | null;
  quizPayload: any;
  ocrBudget: OcrBudget;
}) {
  const questionSlides = getISpringQuestionSlides(options.quizPayload);
  const metadata: ScormQuestionMetadata[] = [];
  let trackableQuestionIndex = 0;

  for (const slide of questionSlides) {
    if (!isTrackableISpringQuestion(slide)) {
      continue;
    }

    const questionId = normalizeMetadataIdentifier(slide.i);
    const type = normalizeScormQuestionText(slide.tp);
    const directQuestionText = extractISpringQuestionDirectText(slide);
    const objectPromptTexts = extractISpringObjectPromptTexts(slide);
    const imageStorageRefs = Array.from(collectStorageImageReferences(slide));
    const imageAssetPaths = uniqueNormalizedStrings(
      imageStorageRefs.flatMap((storageRef) => resolveExistingAssetPaths({ quizAssetPath: options.quizAssetPath, storageReference: storageRef }))
    );
    const needsOcr = !isUsefulQuestionText(directQuestionText) && objectPromptTexts.length === 0 && imageAssetPaths.length > 0;
    const ocrSupplement = needsOcr
      ? await extractOcrQuestionSupplement(imageAssetPaths, options.ocrBudget)
      : { question: "", choices: [] as string[] };
    const questionText = chooseBestQuestionText(directQuestionText, objectPromptTexts, ocrSupplement.question);
    const questionPrompt = chooseQuestionPrompt(directQuestionText, objectPromptTexts, questionText);
    const choices = extractISpringChoices(slide, ocrSupplement.choices);
    const correctResponses = uniqueNormalizedStrings(
      choices.filter((choice) => choice.isCorrect).map((choice) => choice.text || choice.id || String(choice.index))
    );
    const slideNumber = options.quizStartSlide !== null ? options.quizStartSlide + 1 : null;
    const interactionIds = buildISpringInteractionAliases({
      slideNumber,
      questionId,
      questionIndex: trackableQuestionIndex,
      directQuestionText,
      finalQuestionText: questionText,
    });

    metadata.push({
      questionId,
      interactionId: interactionIds[0] || questionId,
      interactionIds,
      slideNumber,
      quizIndex: options.quizIndex,
      questionIndex: trackableQuestionIndex,
      type,
      question: questionText,
      questionPrompt,
      choices,
      correctResponses,
      imageAssetPaths,
      sourceAssetPath: options.quizAssetPath,
    });

    trackableQuestionIndex += 1;
  }

  return metadata;
}

async function extractISpringQuestionMetadata(indexAssetPath: string, indexContents: string) {
  const quizStartSlides = parseISpringQuizSlideMap(indexContents);
  const normalizedIndexPath = normalizeCourseAssetPath(indexAssetPath);
  const indexDirectory = path.posix.dirname(normalizedIndexPath);

  const packagePrefix = normalizedIndexPath.split("/").filter(Boolean)[0];
  const manifestPath = packagePrefix ? `/${packagePrefix}/imsmanifest.xml` : null;
  const manifestXml = manifestPath ? await readCourseAssetText(manifestPath).catch(() => null) : null;
  const inferredMapping = manifestXml ? inferQuizSlideNumberFromManifest(manifestXml) : {};

  const ocrBudget: OcrBudget = {
    remaining: isScormQuestionOcrEnabled() ? getScormQuestionOcrLimit() : 0,
  };
  const quizCount = quizStartSlides.length || 50;
  const metadata: ScormQuestionMetadata[] = [];
  let missingQuizStreak = 0;

  for (let quizIndex = 1; quizIndex <= quizCount; quizIndex += 1) {
    const quizAssetPath = buildCourseAssetPath(indexDirectory, "data", `quiz${quizIndex}.js`);
    const quizContents = await readCourseAssetText(quizAssetPath);
    if (!quizContents) {
      missingQuizStreak += 1;
      if (!quizStartSlides.length && missingQuizStreak >= 3) {
        break;
      }
      continue;
    }

    missingQuizStreak = 0;
    const quizPayload = parseISpringQuizPayload(quizContents);
    if (!quizPayload) {
      continue;
    }

    const quizFileKey = `res/data/quiz${quizIndex}.js`;
    let quizStartSlide = quizStartSlides[quizIndex - 1] ?? null;
    if (quizStartSlide === null && inferredMapping[quizFileKey] !== undefined) {
      quizStartSlide = inferredMapping[quizFileKey] - 1;
    }

    metadata.push(
      ...(await buildISpringQuestionMetadata({
        quizAssetPath,
        quizIndex,
        quizStartSlide,
        quizPayload,
        ocrBudget,
      }))
    );
  }

  return enrichImageQuestionChoicesFromTextDuplicates(metadata);
}

async function uploadFileToSupabase(filePath: string, objectPath: string) {
  await ensureSupabaseBucket();

  const fileStats = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath);
  const response = await axios.post(
    `${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}/${encodeObjectPath(objectPath)}`,
    fileStream,
    {
      headers: {
        ...getSupabaseAuthHeaders(),
        "Content-Type": getContentType(filePath),
        "Content-Length": String(fileStats.size),
        "x-upsert": "false",
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to upload ${objectPath} to Supabase Storage: ${response.status}`);
  }
}

async function deleteSupabasePrefixes(prefixes: string[]) {
  if (!isSupabaseStorageConfigured() || prefixes.length === 0) {
    return;
  }

  const response = await axios.delete(`${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}`, {
    headers: {
      ...getSupabaseAuthHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      prefixes,
    },
    validateStatus: () => true,
  });

  if (response.status >= 200 && response.status < 300) {
    return;
  }

  throw new Error(`Failed to delete SCORM assets from Supabase Storage: ${response.status}`);
}

async function uploadDirectoryToSupabase(directoryPath: string, packageId: string) {
  const files = walkDirectoryFiles(directoryPath);
  const concurrency = getRemoteStorageUploadConcurrency();

  for (let index = 0; index < files.length; index += concurrency) {
    const uploadBatch = files.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      uploadBatch.map((filePath) => {
        const relativePath = path.relative(directoryPath, filePath).replace(/\\/g, "/");
        const objectPath = `${packageId}/${relativePath}`;
        return uploadFileToSupabase(filePath, objectPath)
          .then(() => ({ ok: true as const }))
          .catch((error) => ({ ok: false as const, error }));
      })
    );

    const rejectedResult = batchResults.find(
      (result): result is { ok: false; error: any } => !result.ok
    );

    if (rejectedResult) {
      throw rejectedResult.error;
    }
  }
}

async function uploadDirectoryToS3(directoryPath: string, packageId: string) {
  const files = walkDirectoryFiles(directoryPath);
  const concurrency = getRemoteStorageUploadConcurrency();

  for (let index = 0; index < files.length; index += concurrency) {
    const uploadBatch = files.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      uploadBatch.map((filePath) => {
        const relativePath = path.relative(directoryPath, filePath).replace(/\\/g, "/");
        const objectPath = `${packageId}/${relativePath}`;
        return uploadFileToS3(filePath, objectPath, "scorm")
          .then(() => ({ ok: true as const }))
          .catch((error) => ({ ok: false as const, error }));
      })
    );

    const rejectedResult = batchResults.find(
      (result): result is { ok: false; error: any } => !result.ok
    );

    if (rejectedResult) {
      throw rejectedResult.error;
    }
  }
}

function extractToLocalStorage(scormZipFile: Express.Multer.File) {
  return extractZipFileToLocalStorage(scormZipFile.path, scormZipFile.originalname);
}

function extractZipFileToLocalStorage(zipFilePath: string, originalName: string) {
  ensureDirectory(LOCAL_SCORM_ROOT);

  const packageId = uuidv4();
  const extractPath = path.join(LOCAL_SCORM_ROOT, packageId);
  ensureDirectory(extractPath);

  const zip = new AdmZip(zipFilePath);
  zip.extractAllTo(extractPath, true);
  cleanupFileIfPresent(zipFilePath);

  const entryPointAbsPath = findLaunchFile(extractPath);
  if (!entryPointAbsPath) {
    removeDirectoryIfSafe(extractPath, LOCAL_SCORM_ROOT);
    throw new Error(`No valid HTML entry point found in ${originalName}`);
  }

  const entryPointRelativePath = path.relative(extractPath, entryPointAbsPath).replace(/\\/g, "/");
  return `/${packageId}/${entryPointRelativePath}`;
}

function storeCourseAssetPathToLocalStorage(sourceFilePath: string, originalName: string) {
  ensureDirectory(LOCAL_SCORM_ROOT);

  const assetId = `asset-${uuidv4()}`;
  const fileName = sanitizeFileName(originalName || path.basename(sourceFilePath) || "asset");
  const assetDirectory = path.join(LOCAL_SCORM_ROOT, assetId);
  const storedAssetPath = path.join(assetDirectory, fileName);

  ensureDirectory(assetDirectory);
  fs.copyFileSync(sourceFilePath, storedAssetPath);

  return `/${assetId}/${fileName}`;
}

function storeCourseAssetToLocalStorage(assetFile: Express.Multer.File) {
  try {
    return storeCourseAssetPathToLocalStorage(assetFile.path, assetFile.originalname || assetFile.filename || "asset");
  } finally {
    cleanupFileIfPresent(assetFile.path);
  }
}

export async function extractAndStoreScormPackage(scormZipFile: Express.Multer.File) {
  if (isAwsS3Configured()) {
    return extractZipFileToS3(scormZipFile.path, scormZipFile.originalname);
  }

  if (!isSupabaseStorageConfigured()) {
    return extractToLocalStorage(scormZipFile);
  }

  return extractZipFileToSupabase(scormZipFile.path, scormZipFile.originalname);
}

async function extractZipFileToS3(zipFilePath: string, originalName: string) {
  const packageId = uuidv4();
  const extractPath = path.join(TEMP_EXTRACT_ROOT, packageId);
  ensureDirectory(extractPath);

  try {
    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(extractPath, true);
    cleanupFileIfPresent(zipFilePath);

    const entryPointAbsPath = findLaunchFile(extractPath);
    if (!entryPointAbsPath) {
      throw new Error(`No valid HTML entry point found in ${originalName}`);
    }

    await uploadDirectoryToS3(extractPath, packageId);

    const entryPointRelativePath = path.relative(extractPath, entryPointAbsPath).replace(/\\/g, "/");
    return `/${packageId}/${entryPointRelativePath}`;
  } catch (error) {
    await deleteS3Prefixes([packageId], "scorm").catch((cleanupError) => {
      console.warn("Failed to clean up partially uploaded SCORM package from S3.", cleanupError);
    });
    throw error;
  } finally {
    removeDirectoryIfSafe(extractPath, TEMP_EXTRACT_ROOT);
    cleanupFileIfPresent(zipFilePath);
  }
}

async function extractZipFileToSupabase(zipFilePath: string, originalName: string) {
  const packageId = uuidv4();
  const extractPath = path.join(TEMP_EXTRACT_ROOT, packageId);
  ensureDirectory(extractPath);

  try {
    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(extractPath, true);
    cleanupFileIfPresent(zipFilePath);

    const entryPointAbsPath = findLaunchFile(extractPath);
    if (!entryPointAbsPath) {
      throw new Error(`No valid HTML entry point found in ${originalName}`);
    }

    await uploadDirectoryToSupabase(extractPath, packageId);

    const entryPointRelativePath = path.relative(extractPath, entryPointAbsPath).replace(/\\/g, "/");
    return `/${packageId}/${entryPointRelativePath}`;
  } catch (error) {
    await deleteSupabasePrefixes([packageId]).catch((cleanupError) => {
      console.warn("Failed to clean up partially uploaded SCORM package.", cleanupError);
    });
    throw error;
  } finally {
    removeDirectoryIfSafe(extractPath, TEMP_EXTRACT_ROOT);
    cleanupFileIfPresent(zipFilePath);
  }
}

async function storeCourseAssetPathToSupabase(sourceFilePath: string, originalName: string) {
  const assetId = `asset-${uuidv4()}`;
  const fileName = sanitizeFileName(originalName || path.basename(sourceFilePath) || "asset");
  const objectPath = `${assetId}/${fileName}`;

  await uploadFileToSupabase(sourceFilePath, objectPath);
  return `/${objectPath}`;
}

async function storeCourseAssetToSupabase(assetFile: Express.Multer.File) {
  try {
    return await storeCourseAssetPathToSupabase(assetFile.path, assetFile.originalname || assetFile.filename || "asset");
  } finally {
    cleanupFileIfPresent(assetFile.path);
  }
}

async function storeCourseAssetPathToS3(sourceFilePath: string, originalName: string) {
  const assetId = `asset-${uuidv4()}`;
  const fileName = sanitizeFileName(originalName || path.basename(sourceFilePath) || "asset");
  const objectPath = `${assetId}/${fileName}`;

  await uploadFileToS3(sourceFilePath, objectPath, "asset");
  return `/${objectPath}`;
}

async function storeCourseAssetToS3(assetFile: Express.Multer.File) {
  try {
    return await storeCourseAssetPathToS3(assetFile.path, assetFile.originalname || assetFile.filename || "asset");
  } finally {
    cleanupFileIfPresent(assetFile.path);
  }
}

export async function storeCourseAssetFile(assetFile: Express.Multer.File) {
  if (isAwsS3Configured()) {
    return storeCourseAssetToS3(assetFile);
  }

  if (!isSupabaseStorageConfigured()) {
    return storeCourseAssetToLocalStorage(assetFile);
  }

  return storeCourseAssetToSupabase(assetFile);
}

export async function storeScormUploadChunk(uploadId: string, chunkIndex: number, chunkBuffer: Buffer) {
  const normalizedUploadId = normalizeChunkUploadId(uploadId);

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("Invalid SCORM chunk index");
  }

  if (isAwsS3Configured()) {
    await uploadBufferToS3(
      chunkBuffer,
      getChunkObjectPath(normalizedUploadId, chunkIndex),
      "application/octet-stream",
      "chunk"
    );
    return;
  }

  if (isSupabaseStorageConfigured()) {
    await uploadBufferToSupabase(
      chunkBuffer,
      getChunkObjectPath(normalizedUploadId, chunkIndex),
      "application/octet-stream",
      true
    );
    return;
  }

  const localChunkDirectory = getLocalChunkDirectory(normalizedUploadId);
  ensureDirectory(localChunkDirectory);
  fs.writeFileSync(getLocalChunkPath(normalizedUploadId, chunkIndex), chunkBuffer);
}

async function downloadChunkFromS3(uploadId: string, chunkIndex: number) {
  const s3 = getS3Client();
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: buildS3ObjectKey(getChunkObjectPath(uploadId, chunkIndex), "chunk"),
    })
  );

  return streamBodyToBuffer(response.Body);
}

async function downloadChunkFromSupabase(uploadId: string, chunkIndex: number) {
  const response = await axios.get(
    `${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}/${encodeObjectPath(getChunkObjectPath(uploadId, chunkIndex))}`,
    {
      headers: getSupabaseAuthHeaders(),
      responseType: "arraybuffer",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Missing SCORM upload chunk ${chunkIndex + 1} for upload ${uploadId}`);
  }

  return Buffer.from(response.data);
}

async function materializeChunkedUpload(upload: ChunkedScormUpload) {
  const normalizedUploadId = normalizeChunkUploadId(upload.uploadId);
  const totalChunks = Number(upload.totalChunks);

  if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
    throw new Error("Invalid SCORM upload chunk count");
  }

  const assembledZipPath = path.join(
    TEMP_UPLOAD_ROOT,
    `${normalizedUploadId}-${Date.now()}-${sanitizeFileName(upload.fileName)}`
  );

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunkBuffer = isAwsS3Configured()
      ? await downloadChunkFromS3(normalizedUploadId, chunkIndex)
      : isSupabaseStorageConfigured()
        ? await downloadChunkFromSupabase(normalizedUploadId, chunkIndex)
        : fs.readFileSync(getLocalChunkPath(normalizedUploadId, chunkIndex));

    fs.appendFileSync(assembledZipPath, chunkBuffer);
  }

  return assembledZipPath;
}

export async function deleteScormUploadChunks(uploadId: string) {
  const normalizedUploadId = normalizeChunkUploadId(uploadId);
  const localChunkDirectory = getLocalChunkDirectory(normalizedUploadId);

  if (fs.existsSync(localChunkDirectory)) {
    removeDirectoryIfSafe(localChunkDirectory, TEMP_CHUNK_ROOT);
  }

  if (!isSupabaseStorageConfigured()) {
    if (!isAwsS3Configured()) {
      return;
    }
  }

  if (isAwsS3Configured()) {
    await deleteS3Prefixes([`${SUPABASE_CHUNK_PREFIX}/${normalizedUploadId}`], "chunk");
    return;
  }

  await deleteSupabasePrefixes([`${SUPABASE_CHUNK_PREFIX}/${normalizedUploadId}`]);
}

export async function extractAndStoreChunkedScormPackage(upload: ChunkedScormUpload) {
  const assembledZipPath = await materializeChunkedUpload(upload);

  try {
    if (isAwsS3Configured()) {
      return extractZipFileToS3(assembledZipPath, upload.fileName);
    }

    if (!isSupabaseStorageConfigured()) {
      return extractZipFileToLocalStorage(assembledZipPath, upload.fileName);
    }

    return await extractZipFileToSupabase(assembledZipPath, upload.fileName);
  } finally {
    cleanupFileIfPresent(assembledZipPath);

    try {
      await deleteScormUploadChunks(upload.uploadId);
    } catch (cleanupError) {
      console.warn("Failed to clean up SCORM upload chunks.", cleanupError);
    }
  }
}

export async function storeChunkedCourseAssetFile(upload: ChunkedAssetUpload) {
  const assembledFilePath = await materializeChunkedUpload(upload);

  try {
    if (isAwsS3Configured()) {
      return storeCourseAssetPathToS3(assembledFilePath, upload.fileName);
    }

    if (!isSupabaseStorageConfigured()) {
      return storeCourseAssetPathToLocalStorage(assembledFilePath, upload.fileName);
    }

    return await storeCourseAssetPathToSupabase(assembledFilePath, upload.fileName);
  } finally {
    cleanupFileIfPresent(assembledFilePath);

    try {
      await deleteScormUploadChunks(upload.uploadId);
    } catch (cleanupError) {
      console.warn("Failed to clean up chunked course asset upload.", cleanupError);
    }
  }
}

function collectPackagePrefixesFromPaths(assetPaths: string[]) {
  const packagePrefixes = new Set<string>();

  for (const candidatePath of assetPaths) {
    try {
      const normalizedPath = normalizeCourseAssetPath(candidatePath);
      const packagePrefix = normalizedPath.split("/")[0];
      if (packagePrefix) {
        packagePrefixes.add(packagePrefix);
      }
    } catch (error) {
      console.warn("Skipping invalid SCORM path during cleanup.", error);
    }
  }

  return [...packagePrefixes];
}

function collectPackagePrefixes(course: CourseLike) {
  const candidatePaths: string[] = [];

  if (course.scormFilePath) {
    candidatePaths.push(course.scormFilePath);
  }

  for (const moduleItem of course.curriculum?.modules || []) {
    for (const material of moduleItem.studyMaterial || []) {
      if (material?.previewUrl) {
        candidatePaths.push(material.previewUrl);
      }
    }

    for (const section of moduleItem.sections || []) {
      const content = section.content;
      if (content?.previewUrl) {
        candidatePaths.push(content.previewUrl);
      }

      for (const material of section.studyMaterial || []) {
        if (material?.previewUrl) {
          candidatePaths.push(material.previewUrl);
        }
      }
    }
  }

  return collectPackagePrefixesFromPaths(candidatePaths);
}

export async function deleteScormAssetsByPaths(assetPaths: string[]) {
  const packagePrefixes = collectPackagePrefixesFromPaths(assetPaths);

  for (const packagePrefix of packagePrefixes) {
    const localPackageDir = path.join(LOCAL_SCORM_ROOT, packagePrefix);
    if (isInsideDirectory(LOCAL_SCORM_ROOT, localPackageDir) && fs.existsSync(localPackageDir)) {
      removeDirectoryIfSafe(localPackageDir, LOCAL_SCORM_ROOT);
    }
  }

  if (packagePrefixes.length === 0) {
    return;
  }

  if (isAwsS3Configured()) {
    const scormPrefixes = packagePrefixes.filter((prefix) => getRemoteStorageKindForPrefix(prefix) === "scorm");
    const assetPrefixes = packagePrefixes.filter((prefix) => getRemoteStorageKindForPrefix(prefix) === "asset");

    await deleteS3Prefixes(scormPrefixes, "scorm");
    await deleteS3Prefixes(assetPrefixes, "asset");
    return;
  }

  if (!isSupabaseStorageConfigured()) {
    return;
  }

  await deleteSupabasePrefixes(packagePrefixes);
}

export async function deleteCourseScormAssets(course: CourseLike) {
  const assetPaths: string[] = [];

  if (course.scormFilePath) {
    assetPaths.push(course.scormFilePath);
  }

  for (const moduleItem of course.curriculum?.modules || []) {
    for (const material of moduleItem.studyMaterial || []) {
      if (material?.previewUrl) {
        assetPaths.push(material.previewUrl);
      }
    }

    for (const section of moduleItem.sections || []) {
      if (section.content?.previewUrl) {
        assetPaths.push(section.content.previewUrl);
      }

      for (const material of section.studyMaterial || []) {
        if (material?.previewUrl) {
          assetPaths.push(material.previewUrl);
        }
      }
    }
  }

  await deleteScormAssetsByPaths(
    assetPaths
  );
}

function sendSupabaseResponseHeaders(response: Response, upstreamResponse: AxiosResponse, assetPath: string) {
  const passthroughHeaders = [
    "content-length",
    "cache-control",
    "content-encoding",
    "content-range",
    "etag",
    "expires",
    "last-modified",
    "content-disposition",
    "accept-ranges",
    "vary",
  ];

  for (const headerName of passthroughHeaders) {
    const headerValue = upstreamResponse.headers[headerName];
    if (headerValue) {
      response.setHeader(headerName, headerValue as string);
    }
  }

  response.setHeader("content-type", getContentType(assetPath));
  if (!response.hasHeader("cache-control")) {
    response.setHeader("cache-control", "public, max-age=604800, stale-while-revalidate=2592000");
  }
}

function sendS3ResponseHeaders(response: Response, assetResponse: any, assetPath: string) {
  if (assetResponse.ContentLength !== undefined) {
    response.setHeader("content-length", String(assetResponse.ContentLength));
  }

  if (assetResponse.CacheControl) {
    response.setHeader("cache-control", assetResponse.CacheControl);
  }

  if (assetResponse.ETag) {
    response.setHeader("etag", assetResponse.ETag);
  }

  if (assetResponse.LastModified instanceof Date) {
    response.setHeader("last-modified", assetResponse.LastModified.toUTCString());
  }

  if (assetResponse.ContentDisposition) {
    response.setHeader("content-disposition", assetResponse.ContentDisposition);
  }

  if (assetResponse.AcceptRanges) {
    response.setHeader("accept-ranges", assetResponse.AcceptRanges);
  }

  if (assetResponse.ContentRange) {
    response.status(206);
    response.setHeader("content-range", assetResponse.ContentRange);
  }

  response.setHeader("content-type", assetResponse.ContentType || getContentType(assetPath));
  response.setHeader(
    "cache-control",
    assetResponse.CacheControl || "public, max-age=604800, stale-while-revalidate=2592000"
  );
}

async function readCourseAssetText(assetPath: string) {
  const normalizedAssetPath = normalizeCourseAssetPath(assetPath);
  const localFilePath = path.join(LOCAL_SCORM_ROOT, ...normalizedAssetPath.split("/"));

  if (
    isInsideDirectory(LOCAL_SCORM_ROOT, localFilePath) &&
    fs.existsSync(localFilePath) &&
    fs.statSync(localFilePath).isFile()
  ) {
    return fs.readFileSync(localFilePath, "utf8");
  }

  if (isAwsS3Configured()) {
    try {
      const s3 = getS3Client();
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: buildS3ObjectKey(normalizedAssetPath, "scorm"),
        })
      );

      const buffer = await streamBodyToBuffer(response.Body);
      return buffer.toString("utf8");
    } catch (error: any) {
      const statusCode = error?.$metadata?.httpStatusCode;
      if (statusCode === 404 || error?.name === "NoSuchKey") {
        return null;
      }

      throw error;
    }
  }

  if (!isSupabaseStorageConfigured()) {
    return null;
  }

  const upstreamResponse = await axios.get(
    `${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}/${encodeObjectPath(normalizedAssetPath)}`,
    {
      headers: getSupabaseAuthHeaders(),
      responseType: "arraybuffer",
      validateStatus: () => true,
    }
  );

  if (upstreamResponse.status === 404) {
    return null;
  }

  if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
    throw new Error(
      `Failed to fetch SCORM metadata asset from Supabase Storage: ${upstreamResponse.status} for ${normalizedAssetPath}`
    );
  }

  return Buffer.from(upstreamResponse.data).toString("utf8");
}

function buildScormMetadataCandidatePaths(assetPath: string) {
  const normalizedAssetPath = normalizeCourseAssetPath(assetPath);
  const pathSegments = normalizedAssetPath.split("/").filter(Boolean);
  const packagePrefix = pathSegments[0];
  const relativeAssetPath = pathSegments.slice(1).join("/");
  const relativeDirectory = path.posix.dirname(relativeAssetPath);
  const candidateRelativePaths = [
    relativeAssetPath,
    path.posix.join(relativeDirectory === "." ? "" : relativeDirectory, "res/index.html"),
    path.posix.join(relativeDirectory === "." ? "" : relativeDirectory, "data.js"),
    path.posix.join(relativeDirectory === "." ? "" : relativeDirectory, "presentation_content/data.js"),
    path.posix.join(relativeDirectory === "." ? "" : relativeDirectory, "presentation_content/vars.js"),
    path.posix.join(relativeDirectory === "." ? "" : relativeDirectory, "story_content/data.js"),
    "res/index.html",
    "data.js",
    "presentation_content/data.js",
    "presentation_content/vars.js",
    "story_content/data.js",
  ];

  const candidatePaths = new Set<string>();
  candidateRelativePaths
    .filter(Boolean)
    .forEach((candidateRelativePath) => {
      candidatePaths.add(`/${packagePrefix}/${candidateRelativePath.replace(/^\/+/, "")}`);
    });

  return Array.from(candidatePaths);
}

export async function getScormAssetSlideMetadata(
  assetPath: string | null | undefined,
  options: { includeQuestions?: boolean } = {}
): Promise<ScormSlideMetadata | null> {
  const normalizedInput = String(assetPath || "").trim();
  if (!normalizedInput) {
    return null;
  }

  const normalizedAssetPath = normalizeCourseAssetPath(normalizedInput);
  const includeQuestions = options.includeQuestions === true;
  const cacheKey = `${normalizedAssetPath}|questions:${includeQuestions ? "yes" : "no"}`;
  const cachedResult = scormSlideMetadataCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  const metadataPromise = (async () => {
    const candidatePaths = buildScormMetadataCandidatePaths(normalizedAssetPath);
    let totalSlides: number | null = null;
    let sourceAssetPath: string | null = null;
    let iSpringIndexPath: string | null = null;
    let iSpringIndexContents = "";

    for (const candidatePath of candidatePaths) {
      try {
        const assetContents = await readCourseAssetText(candidatePath);
        if (!assetContents) {
          continue;
        }

        if (totalSlides === null) {
          const candidateTotalSlides = extractSlideCountFromText(assetContents);
          if (candidateTotalSlides !== null) {
            totalSlides = candidateTotalSlides;
            sourceAssetPath = candidatePath;
          }
        }

        if (
          includeQuestions &&
          !iSpringIndexPath &&
          /\bquizzes\s*:/.test(assetContents) &&
          /var\s+quizInfo\s*=/.test(assetContents) === false
        ) {
          iSpringIndexPath = candidatePath;
          iSpringIndexContents = assetContents;
        }

        if (totalSlides !== null && (!includeQuestions || iSpringIndexPath)) {
          break;
        }
      } catch (error) {
        console.warn(`Unable to inspect SCORM asset metadata for ${candidatePath}.`, error);
      }
    }

    const questions = includeQuestions && iSpringIndexPath
      ? await extractISpringQuestionMetadata(iSpringIndexPath, iSpringIndexContents).catch((error) => {
          console.warn(`Unable to extract SCORM question metadata for ${iSpringIndexPath}.`, error);
          return [] as ScormQuestionMetadata[];
        })
      : [];

    return {
      totalSlides,
      sourceAssetPath,
      questions,
    } satisfies ScormSlideMetadata;
  })().catch((error) => {
    scormSlideMetadataCache.delete(cacheKey);
    throw error;
  });

  scormSlideMetadataCache.set(cacheKey, metadataPromise);
  return metadataPromise;
}

export async function serveCourseAsset(assetPath: string, response: Response) {
  const normalizedAssetPath = normalizeCourseAssetPath(assetPath);
  const localFilePath = path.join(LOCAL_SCORM_ROOT, ...normalizedAssetPath.split("/"));
  const requestedRange = response.req?.headers?.range;

  if (isInsideDirectory(LOCAL_SCORM_ROOT, localFilePath) && fs.existsSync(localFilePath) && fs.statSync(localFilePath).isFile()) {
    response.sendFile(localFilePath, {
      maxAge: "7d",
      immutable: true,
    });
    return true;
  }

  if (isAwsS3Configured()) {
    const storageKind = getRemoteStorageKindForPrefix(normalizedAssetPath.split("/")[0] || "");

    try {
      const s3 = getS3Client();
      const assetResponse = await s3.send(
        new GetObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: buildS3ObjectKey(normalizedAssetPath, storageKind),
          ...(requestedRange ? { Range: requestedRange } : {}),
        })
      );

      sendS3ResponseHeaders(response, assetResponse, normalizedAssetPath);

      const readableBody = toNodeReadable(assetResponse.Body);
      if (readableBody) {
        readableBody.pipe(response);
      } else {
        const bufferedBody = await streamBodyToBuffer(assetResponse.Body);
        response.send(bufferedBody);
      }

      return true;
    } catch (error: any) {
      const statusCode = error?.$metadata?.httpStatusCode;
      if (statusCode !== 404 && error?.name !== "NoSuchKey") {
        throw error;
      }
    }
  }

  if (!isSupabaseStorageConfigured()) {
    return false;
  }

  const upstreamResponse = await axios.get(
    `${SUPABASE_STORAGE_BASE_URL}/object/${SUPABASE_SCORM_BUCKET}/${encodeObjectPath(normalizedAssetPath)}`,
    {
      headers: {
        ...getSupabaseAuthHeaders(),
        ...(requestedRange ? { Range: requestedRange } : {}),
      },
      responseType: "stream",
      validateStatus: () => true,
    }
  );

  if (upstreamResponse.status === 404) {
    return false;
  }

  if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
    throw new Error(`Failed to fetch SCORM asset from Supabase Storage: ${upstreamResponse.status} for ${normalizedAssetPath}`);
  }

  sendSupabaseResponseHeaders(response, upstreamResponse, normalizedAssetPath);
  response.status(upstreamResponse.status);
  upstreamResponse.data.pipe(response);
  return true;
}

export function hasSupabaseScormStorage() {
  return hasRemoteCourseStorage();
}
