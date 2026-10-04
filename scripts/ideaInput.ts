#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs';

const idea = process.env.BUILDER_IDEA || '';
if (!idea.trim()) {
  console.error('BUILDER_IDEA required');
  process.exit(1);
}
mkdirSync('.builder', { recursive: true });
writeFileSync('.builder/idea.txt', idea);
console.log('Idea captured');
