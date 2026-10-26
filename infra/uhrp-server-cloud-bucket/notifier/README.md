# UHRP Storage Notifier

This is a simple Google Cloud Function that is triggered whenever a new object is finalized in the Cloud Storage bucket.

The function calculates the hash of the new object, determines which storage contract it relates to (based on the Object ID), and then calls the HTTP route that makes a UHRP advertisement.

The root CI validates this package, while deployment remains an explicit
operator-owned action. Use a reviewed identity and immutable source revision;
do not deploy from an uncommitted workstation tree.

This is usually a one-time setup process per storage deployment.


## Notes

For getting --gen2 functions to work, running this is required:

```
gcloud storage buckets add-iam-policy-binding gs://YOUR_UHRP_BUCKET \
  --member=serviceAccount:service-$(gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)")@gcp-sa-eventarc.iam.gserviceaccount.com \
  --role=roles/storage.legacyBucketReader

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member=serviceAccount:service-$(gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)")@gs-project-accounts.iam.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

Confirm these are the Google-managed service agents for the exact project and
bucket before applying. Do not substitute the notifier runtime identity or a
user-managed key, and do not grant project Owner/Editor.
