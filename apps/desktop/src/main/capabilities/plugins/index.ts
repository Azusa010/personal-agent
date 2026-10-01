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
import { webSearchPlugin } from './web-search'
import { fileReadPlugin } from './file-read'
import { fileWritePlugin } from './file-write'
import { fileEditPlugin } from './file-edit'
import { a2uiRenderPlugin } from './a2ui'

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
export * from './web-search'
export * from './file-read'
export * from './file-write'
export * from './file-edit'
export * from './a2ui'

const BUILTIN_PLUGINS: readonly CapabilityPlugin[] = [
  filesystemListPlugin,
  documentExtractPdfPlugin,
  readDocumentPlugin,
  fileSearchPlugin,
  fileReadPlugin,
  knowledgeSearchPlugin,
  userMemorySearchPlugin,
  vikingReadL0Plugin,
  vikingReadL1Plugin,
  vikingReadL2Plugin,
  skillSearchPlugin,
  skillReadPlugin,
  webSearchPlugin,
  filesystemCreateDirPlugin,
  filesystemMovePlugin,
  fileWritePlugin,
  fileEditPlugin,
  schedulerCreatePlugin,
  notificationSendPlugin,
  terminalExecutePlugin,
  codeInterpreterPlugin,
  vikingWriteL2Plugin,
  a2uiRenderPlugin
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
