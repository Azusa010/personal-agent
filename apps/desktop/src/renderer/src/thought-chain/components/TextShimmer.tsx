import React from 'react'

export interface TextShimmerProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode
  as?: React.ElementType
  className?: string
  duration?: number
}

export const TextShimmer: React.FC<TextShimmerProps> = ({
  children,
  as: Component = 'span',
  className = '',
  duration = 1.5,
  style,
  ...props
}) => {
  return (
    <Component
      className={`an-text-shimmer an-text-shimmer--active select-none ${className}`}
      style={
        {
          '--an-shimmer-duration': `${duration}s`,
          animationDuration: `${duration}s`,
          ...style
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Component>
  )
}
