import { FolderOpen, Folder, X } from 'lucide-react'
import { useState } from 'react'
import type { WorkspaceView } from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'

export interface WorkspaceChipProps {
  workspace: WorkspaceView | null
  onSwitch: (dir: string) => void
  onChoose: () => void
  onRemoveBookmark: (dir: string) => void
}

/** 侧栏底部的工作区旋钮：常显当前目录名，点开 = 书签列表（点击直切）+ 原生选择器。 */
export function WorkspaceChip({
  workspace,
  onSwitch,
  onChoose,
  onRemoveBookmark
}: WorkspaceChipProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const current = workspace?.current ?? ''
  const dirName = current === '' ? '未设置' : (current.split('/').filter(Boolean).pop() ?? current)

  return (
    <div className="relative px-2.5">
      <button
        type="button"
        title={current === '' ? '尚未设置工作区' : current}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] text-foreground/80 transition-colors hover:bg-secondary/70 hover:text-foreground"
      >
        <Folder size={15} className="text-muted-foreground" />
        <span className="truncate">{dirName}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">工作区</span>
      </button>

      {open && (
        <>
          {/* 点弹层外关闭 */}
          <button
            type="button"
            aria-label="关闭工作区菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-9 left-2 right-2 z-50 rounded-[10px] border border-border bg-popover p-1.5 shadow-lg">
            <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-muted-foreground">工作区</div>
            {(workspace?.bookmarks ?? []).map((dir) => {
              const active = dir === current
              const name = dir.split('/').filter(Boolean).pop() ?? dir
              return (
                <div
                  key={dir}
                  className="group flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-[12.5px] hover:bg-secondary/70"
                  title={dir}
                >
                  <button
                    type="button"
                    className={cn(
                      'min-w-0 flex-1 truncate text-left',
                      active ? 'font-medium text-foreground' : 'text-foreground/80'
                    )}
                    onClick={() => {
                      if (!active) onSwitch(dir)
                      setOpen(false)
                    }}
                  >
                    {name}
                    {active && (
                      <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                        当前
                      </span>
                    )}
                  </button>
                  {!active && (
                    <button
                      type="button"
                      title="删除这条书签"
                      onClick={() => onRemoveBookmark(dir)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              )
            })}
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onChoose()
              }}
              className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12.5px] text-foreground/80 hover:bg-secondary/70 hover:text-foreground"
            >
              <FolderOpen size={13} className="text-muted-foreground" />
              选择其他文件夹…
            </button>
          </div>
        </>
      )}
    </div>
  )
}
