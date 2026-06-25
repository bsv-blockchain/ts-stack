-- Create one database per infra component that needs MySQL.
-- All apps connect as root (local dev only); see infra/docker-compose.yaml.
CREATE DATABASE IF NOT EXISTS appdb;              -- overlay-server (Knex)
CREATE DATABASE IF NOT EXISTS wallet_storage;     -- wallet-infra
CREATE DATABASE IF NOT EXISTS `messagebox-backend`; -- message-box-server
CREATE DATABASE IF NOT EXISTS app;                -- wab
