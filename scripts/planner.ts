#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

const idea = process.env.BUILDER_IDEA || 'Sample idea';
const configPath = process.env.BUILDER_CONFIG_PATH || 'builder/config/builder.json';
const config = JSON.parse(execSync(`cat ${configPath}`).toString());

const features = [
  {
    id: 'feat-001',
    title: 'Initialize builder scaffolding',
    description: 'Set up builder module structure and configs',
    paths: ['builder/**'],
    dependencies: []
  },
  {
    id: 'feat-002',
    title: 'Core utilities and queue logic',
    description: 'Implement shared queue utilities',
    paths: ['builder/scripts/**'],
    dependencies: ['feat-001']
  },
  {
    id: 'feat-003',
    title: 'Gradle build integration',
    description: 'Configure Gradle for cloud builds',
    paths: ['builder/gradle/**'],
    dependencies: ['feat-001']
  }
];

mkdirSync('.builder', { recursive: true });
writeFileSync('.builder/queue.json', JSON.stringify({ features, generatedAt: new Date().toISOString() }, null, 2));
writeFileSync('.builder/plan.json', JSON.stringify({ idea, features, config }, null, 2));
console.log(`Planned ${features.length} features`);
