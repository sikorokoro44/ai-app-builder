#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

const idea = process.env.BUILDER_IDEA || 'Simple Android App';
const configPath = process.env.BUILDER_CONFIG_PATH || 'builder/config/builder.json';
const config = JSON.parse(execSync(`cat ${configPath}`).toString());

const features = [
  {
    id: 'feat-app',
    title: 'Generate Android app',
    description: idea,
    paths: ['android/**'],
    dependencies: []
  }
];

mkdirSync('.builder', { recursive: true });
writeFileSync('.builder/queue.json', JSON.stringify({ features, generatedAt: new Date().toISOString() }, null, 2));
writeFileSync('.builder/plan.json', JSON.stringify({ idea, features, config }, null, 2));
writeFileSync('.builder/idea.txt', idea);
console.log(`Planned ${features.length} features`);
