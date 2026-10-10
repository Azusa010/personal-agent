import React, { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { MessageSquare, Code, FileSearch, Sparkles } from 'lucide-react'

export function WelcomeView({ onAction }: { onAction: (text: string) => void }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const tl = gsap.timeline()

      // 1. Entrance animation for the hero greeting
      tl.fromTo(
        '.hero-greeting',
        {
          opacity: 0,
          y: 30,
          scale: 0.95,
          filter: 'blur(10px)'
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          duration: 1,
          ease: 'power3.out'
        }
      )

      // 2. Staggered entrance for the suggestion chips
      tl.fromTo(
        '.suggestion-chip',
        {
          opacity: 0,
          y: 20
        },
        {
          opacity: 1,
          y: 0,
          duration: 0.6,
          stagger: 0.1,
          ease: 'back.out(1.2)'
        },
        '-=0.5'
      )
    },
    { scope: container }
  )

  const handleMagnetic = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left - rect.width / 2
    const y = e.clientY - rect.top - rect.height / 2

    gsap.to(el, {
      x: x * 0.1,
      y: y * 0.1,
      scale: 1.02,
      duration: 0.3,
      ease: 'power2.out'
    })
  }

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>): void => {
    gsap.to(e.currentTarget, {
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.5,
      ease: 'elastic.out(1, 0.3)'
    })
  }

  const suggestions = [
    {
      icon: <Sparkles size={18} />,
      text: 'Help me plan a project',
      prompt: 'Help me plan a new project step by step.'
    },
    {
      icon: <Code size={18} />,
      text: 'Write a React component',
      prompt: 'Write a React component for a data table using Tailwind CSS.'
    },
    {
      icon: <MessageSquare size={18} />,
      text: 'Brainstorm ideas',
      prompt: "Let's brainstorm some ideas for a marketing campaign."
    },
    {
      icon: <FileSearch size={18} />,
      text: 'Summarize a document',
      prompt: 'I want to upload a document and have you summarize it.'
    }
  ]

  return (
    <div
      ref={container}
      className="relative flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-y-auto bg-background px-6 py-6 text-foreground"
    >
      {/* Centered Hero Greeting */}
      <div className="hero-greeting mb-8 max-w-2xl text-center">
        <h1 className="mb-3 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          How can I help you today?
        </h1>
        <p className="text-base text-muted-foreground">Your local, private AI agent is ready.</p>
      </div>

      {/* Suggestion Chips Grid (replaces the massive Bento Grid) */}
      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 md:grid-cols-2">
        {suggestions.map((item, idx) => (
          <button
            key={idx}
            className="suggestion-chip flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors duration-200 hover:bg-secondary"
            onMouseMove={handleMagnetic}
            onMouseLeave={handleMouseLeave}
            onClick={() => onAction(item.prompt)}
          >
            <div className="flex-shrink-0 text-muted-foreground">{item.icon}</div>
            <span className="text-sm font-medium text-card-foreground">{item.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
