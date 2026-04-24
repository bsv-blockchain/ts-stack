#!/bin/bash
set -euo pipefail

GCP_BUCKET_NAME=$1
echo "Deploying stagingNotifier to bucket: $GCP_BUCKET_NAME"

BUCKET_REGION=$(gcloud storage buckets describe gs://$GCP_BUCKET_NAME --format="value(location)")
echo "Bucket $GCP_BUCKET_NAME is in region: $BUCKET_REGION"

gcloud functions deploy stagingNotifier \
    --gen2 \
    --runtime=nodejs22 \
    --env-vars-file=staging.functions.env.yaml \
    --entry-point=notifier \
    --timeout=540 \
    --region=$(echo "$BUCKET_REGION" | tr '[:upper:]' '[:lower:]') \
    --trigger-event=google.storage.object.finalize \
    --trigger-resource=$GCP_BUCKET_NAME \
    --memory=4096 \
    --source .