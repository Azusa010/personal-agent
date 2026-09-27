import type { CapabilityPlugin } from '../plugin'
import { filesystemCreateDirPlugin, filesystemListPlugin, filesystemMovePlugin } from './filesystem'
import { documentExtractPdfPlugin, readDocumentPlugin } from './document'
import { notificationSendPlugin, schedulerCreatePlugin } from './scheduler'
import { terminalExecutePlugin } from './terminal'
import { knowledgeSearchPlugin, userMemorySearchPlugin } from './knowledge'
import {
  vikingReadL0Plugin,
  vikingReadL1Plugin,
  vikingReadL2Plugin,
  vikingWriteL2Plugin
} from './viking'
import { codeInterpreterPlugin } from './code-interpreter'
import { fileSearchPlugin } from './file-search'
import { skillReadPlugin, skillSearchPlugin } from './skills'

export * from '../plugin'
export * from './helpers'
export * from './filesystem'
export * from './document'
export * from './scheduler'
export * from './terminal'
export * from './knowledge'
export * from './viking'
export * from './code-interpreter'
export * from './file-search'
export * from './skills'

const BUILTIN_PLUGINS: readonly CapabilityPlugin[] = [
  filesystemListPlugin,
  documentExtractPdfPlugin,
  readDocumentPlugin,
  fileSearchPlugin,
  knowledgeSearchPlugin,
  userMemorySearchPlugin,
  vikingReadL0Plugin,
  vikingReadL1Plugin,
  vikingReadL2Plugin,
  skillSearchPlugin,
  skillReadPlugin,
  filesystemCreateDirPlugin,
  filesystemMovePlugin,
  schedulerCreatePlugin,
  notificationSendPlugin,
  terminalExecutePlugin,
  codeInterpreterPlugin,
  vikingWriteL2Plugin
]

const registry = new Map<string, CapabilityPlugin>()

for (const plugin of BUILTIN_PLUGINS) {
  registry.set(plugin.name, plugin)
}

export function getCapabilityPlugin(name: string): CapabilityPlugin | undefined {
  return registry.get(name)
}

export function listCapabilityPlugins(): readonly CapabilityPlugin[] {
  return Array.from(registry.values())
}

export function registerCapabilityPlugin(plugin: CapabilityPlugin): void {
  registry.set(plugin.name, plugin)
}
