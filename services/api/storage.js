const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  PutBucketCorsCommand,
} = require('@aws-sdk/client-s3');
const fs = require('node:fs/promises');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const UPLOAD_EXPIRY_SECONDS = 600;
const DOWNLOAD_EXPIRY_SECONDS = 300;

function createStorage(env = process.env) {
  const bucket = env.OBJECT_STORAGE_BUCKET || 'arena-submissions';
  const endpoint = env.OBJECT_STORAGE_ENDPOINT || 'http://minio:4566';
  const publicEndpoint = env.OBJECT_STORAGE_PUBLIC_ENDPOINT || endpoint;
  const credentials = {
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY || 'test',
    secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY || 'test',
  };
  const options = {
    region: env.OBJECT_STORAGE_REGION || 'us-east-1',
    credentials,
    forcePathStyle: true,
  };
  const internal = new S3Client({ ...options, endpoint });
  const publicClient = new S3Client({ ...options, endpoint: publicEndpoint });

  async function ensureBucket() {
    try {
      await internal.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!['NotFound', 'NoSuchBucket', '404'].includes(String(error.name)) &&
          error.$metadata?.httpStatusCode !== 404) throw error;
      if (env.OBJECT_STORAGE_AUTO_CREATE !== 'true') throw error;
      try {
        await internal.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (createError) {
        if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(createError.name)) {
          throw createError;
        }
      }
    }
    await internal.send(new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [{
          AllowedOrigins: [env.OBJECT_STORAGE_CORS_ORIGIN || 'http://localhost:8081'],
          AllowedMethods: ['GET', 'HEAD', 'POST'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 600,
        }],
      },
    }));
  }

  async function createUploadForm(key) {
    const form = await createPresignedPost(publicClient, {
      Bucket: bucket,
      Key: key,
      Expires: UPLOAD_EXPIRY_SECONDS,
      Fields: { 'Content-Type': 'application/zip' },
      Conditions: [
        ['content-length-range', 1, MAX_SOURCE_BYTES],
        ['eq', '$Content-Type', 'application/zip'],
      ],
    });
    return {
      method: 'POST',
      url: form.url,
      fields: form.fields,
      max_bytes: MAX_SOURCE_BYTES,
      expires_in_seconds: UPLOAD_EXPIRY_SECONDS,
    };
  }

  async function confirmSource(stagingKey, finalKey) {
    let metadata;
    try {
      metadata = await internal.send(new HeadObjectCommand({ Bucket: bucket, Key: stagingKey }));
    } catch (error) {
      if (['NotFound', 'NoSuchKey', '404'].includes(String(error.name)) ||
          error.$metadata?.httpStatusCode === 404) {
        const missing = new Error('source_not_uploaded');
        missing.statusCode = 409;
        throw missing;
      }
      throw error;
    }
    const byteSize = Number(metadata.ContentLength);
    if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_SOURCE_BYTES) {
      const invalid = new Error('source_size_invalid');
      invalid.statusCode = 413;
      throw invalid;
    }
    if (metadata.ContentType !== 'application/zip') {
      const invalid = new Error('source_content_type_invalid');
      invalid.statusCode = 415;
      throw invalid;
    }

    // Copying server-side to a different key makes the confirmed artifact
    // immutable even while the original presigned upload form is still valid.
    const copySource = `${bucket}/${stagingKey.split('/').map(encodeURIComponent).join('/')}`;
    try {
      await internal.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        CopySource: copySource,
        CopySourceIfMatch: metadata.ETag,
        MetadataDirective: 'COPY',
      }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 412) {
        const changed = new Error('source_changed_during_confirmation');
        changed.statusCode = 409;
        throw changed;
      }
      throw error;
    }
    return byteSize;
  }

  async function sourceDownloadUrl(key) {
    return getSignedUrl(
      publicClient,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: DOWNLOAD_EXPIRY_SECONDS },
    );
  }

  async function downloadObjectToFile(key, destination, maxBytes = 256 * 1024 * 1024) {
    const response = await internal.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = response.Body;
    if (!body) throw new Error('object_body_missing');
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error('object_too_large');
    await fs.writeFile(destination, Buffer.from(bytes));
    return bytes.byteLength;
  }

  async function uploadFile(key, source, contentType = 'application/octet-stream') {
    const body = await fs.readFile(source);
    if (body.byteLength > 256 * 1024 * 1024) throw new Error('object_too_large');
    await internal.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    }));
    return body.byteLength;
  }

  async function health() {
    await internal.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  }

  return {
    ensureBucket,
    createUploadForm,
    confirmSource,
    sourceDownloadUrl,
    downloadObjectToFile,
    uploadFile,
    health,
  };
}

module.exports = { createStorage, MAX_SOURCE_BYTES };
