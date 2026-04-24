#!/bin/bash

# Memory limit for the container
MEMORY_LIMIT="4Gi" # Example: 512Mi, 1Gi, etc.

echo "Creating $1"
echo "apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: $SERVICE
  labels:
    cloud.googleapis.com/location: us-west1
spec:
  template:
    spec:
      timeoutSeconds: 3540
      containers:
      - image: $IMAGE
        resources:
          limits:
            memory: $MEMORY_LIMIT
        env:" > "$1"

echo "Appending environment variables to $1"

# Use Perl to append environment variables with double quotes and escape special chars
echo "Appending to $1"
perl -E'
  for my $var (@ARGV) {
    my $val = $ENV{$var} // "";
    # Escape any double quotes
    $val =~ s/"/\\"/g;
    # Escape any newlines
    $val =~ s/\n/\\n/g;

    say "        - name: $var";
    say "          value: \"$val\"";
  }
' DB_HOST DB_USER DB_PASS DB_NAME \
   TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_VERIFY_SERVICE_SID \
   BSV_NETWORK KNEX_DB_CONNECTION SERVER_PRIVATE_KEY \
   TAAL_API_KEY COMMISSION_FEE COMMISSION_PUBLIC_KEY FEE_MODEL STORAGE_URL >> "$1"

echo "Built! Contents of $1:"
cat "$1"
