#!/bin/sh
# Prepares the local object store: the private media bucket with an upload CORS rule for the web
# app, and the public bucket that the publisher copies final renders into. Safe to re-run against
# a store that already has the buckets. Runs in the amazon/aws-cli image, from docker compose
# (s3-init) and from CI, with AWS_ENDPOINT_URL and the access keys in the environment.
set -eu

MEDIA_BUCKET="${S3_BUCKET:-loomcast-media}"
PUBLIC_BUCKET="${S3_PUBLIC_BUCKET:-loomcast-public}"
UPLOAD_ORIGIN="${UPLOAD_ORIGIN:-http://localhost:5173}"

aws configure set default.s3.addressing_style path

ensure_bucket() {
  if aws s3api head-bucket --bucket "$1" >/dev/null 2>&1; then
    echo "bucket $1 already exists"
  else
    aws s3api create-bucket --bucket "$1"
  fi
}

ensure_bucket "$MEDIA_BUCKET"
ensure_bucket "$PUBLIC_BUCKET"

# Browsers PUT uploads straight to presigned URLs, so the media bucket answers CORS preflights from
# the web app. The checksum header is signed into every upload URL.
aws s3api put-bucket-cors --bucket "$MEDIA_BUCKET" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [\"$UPLOAD_ORIGIN\"],
    \"AllowedMethods\": [\"PUT\", \"GET\", \"HEAD\"],
    \"AllowedHeaders\": [\"content-type\", \"x-amz-checksum-sha256\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3000
  }]
}"

# Anyone may read single objects of the public bucket, but not list it. The anonymous identity in
# s3.json grants the same; the policy also covers a store started before that identity existed.
aws s3api put-bucket-policy --bucket "$PUBLIC_BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"PublicRead\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": [\"s3:GetObject\"],
    \"Resource\": [\"arn:aws:s3:::$PUBLIC_BUCKET/*\"]
  }]
}"

aws s3 ls
