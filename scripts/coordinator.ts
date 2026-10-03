#!/usr/bin/env node
import { execSync } from 'child_process';

const configPath = process.env.BUILDER_CONFIG_PATH || 'builder/config/builder.json';
const config = JSON.parse(execSync(`cat ${configPath}`).toString());
console.log('Coordinator running (one-at-a-time merge policy)', config.coordinator);
