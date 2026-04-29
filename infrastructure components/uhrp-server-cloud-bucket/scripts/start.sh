#!/bin/bash

if [[ "$NODE_ENV" == "production" || "$NODE_ENV" == "staging" ]]; then
  npm run build
  node --max-http-header-size=512000 ./out/src/index.js
else
  npm run dev
fi
