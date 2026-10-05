/**
 * The fleet, as ids only.
 *
 * Kept in its own module with no imports so the planner, the agents and the
 * tests can all ask "is this a real agent?" without creating an import cycle
 * through the registry.
 */

export interface AgentIdDescriptor {
  id: string;
  index: number;
  name: string;
  role: string;
}

/** The twenty agents, in fleet order. The live view and tests both rely on it. */
export const AGENT_IDS: AgentIdDescriptor[] = [
  { id: 'idea-intake', index: 1, name: 'Idea Intake Analyst', role: 'Idea normalization and scope' },
  { id: 'requirements-analyst', index: 2, name: 'Requirements Analyst', role: 'Requirements and acceptance criteria' },
  { id: 'domain-modeler', index: 3, name: 'Domain Modeler', role: 'Entity, fields and actions' },
  { id: 'architect', index: 4, name: 'Software Architect', role: 'Architecture and toolchain' },
  { id: 'ui-designer', index: 5, name: 'UI/UX Designer', role: 'Screens, states and copy' },
  { id: 'security-analyst', index: 6, name: 'Security Analyst', role: 'Permissions, data and secrets' },
  { id: 'feature-planner', index: 7, name: 'Feature Planner', role: 'Features, tasks and dependencies' },
  { id: 'project-scaffolder', index: 8, name: 'Project Scaffolder', role: 'Gradle project skeleton' },
  { id: 'manifest-engineer', index: 9, name: 'Manifest Engineer', role: 'AndroidManifest.xml' },
  { id: 'data-engineer', index: 10, name: 'Data Engineer', role: 'Model and store' },
  { id: 'ui-engineer', index: 11, name: 'UI Engineer', role: 'Compose screen' },
  { id: 'resource-engineer', index: 12, name: 'Resource Engineer', role: 'Strings, colours and theme' },
  { id: 'brand-engineer', index: 13, name: 'Brand and Icon Engineer', role: 'Launcher icon' },
  { id: 'test-engineer', index: 14, name: 'Test Engineer', role: 'Generated unit tests' },
  { id: 'quality-auditor', index: 15, name: 'Quality Auditor', role: 'Pre-publish validation' },
  { id: 'repo-publisher', index: 16, name: 'Repository Publisher', role: 'Commit and push to GitHub' },
  { id: 'build-verifier', index: 17, name: 'Build Verifier', role: 'Cloud build and APK verification' },
  { id: 'release-publisher', index: 18, name: 'Release Publisher', role: 'Release and public download' },
  { id: 'failure-diagnostician', index: 19, name: 'Failure Diagnostician', role: 'Health analysis and classification' },
  { id: 'integration-supervisor', index: 20, name: 'Integration Supervisor', role: 'Cross-agent verification and completion' }
];

export const AGENT_ID_NAMES = AGENT_IDS.map((a) => a.id);

export function isAgentId(id: string): boolean {
  return AGENT_ID_NAMES.includes(id);
}

export function agentIndex(id: string): number {
  return AGENT_IDS.find((a) => a.id === id)?.index ?? 0;
}
