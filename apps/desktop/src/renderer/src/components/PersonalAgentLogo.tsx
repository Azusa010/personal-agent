import type { SVGProps } from 'react'

interface PersonalAgentLogoProps extends SVGProps<SVGSVGElement> {
  size?: number
}

/**
 * PersonalAgent 品牌矢量标识 (The Folio Prism · 折卷智核)
 * 连续几何折页与 P/A 连字轨迹，内嵌薄荷青绿决策智核
 */
export function PersonalAgentLogo({
  size = 20,
  className = '',
  ...props
}: PersonalAgentLogoProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...props}
    >
      {/* 纸白基底底板 */}
      <path
        d="M34 26 C34 21.5 37.5 18 42 18 L73 18 L94 39 L94 94 C94 98.5 90.5 102 86 102 L42 102 C37.5 102 34 98.5 34 94 Z"
        fill="var(--card, #fffdf8)"
        stroke="var(--foreground, #3a372f)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 右上 45° 几何折角 */}
      <path
        d="M73 18 L73 39 L94 39"
        stroke="var(--foreground, #3a372f)"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      {/* P & A 智能轨迹线 */}
      <path
        d="M49 84 L49 38 C49 38 73 35 73 53 C73 68 49 67 49 67 L77 84"
        stroke="var(--mint, #0f9d8f)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* A 横梁 */}
      <path
        d="M43 67 L64 67"
        stroke="var(--mint, #0f9d8f)"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      {/* 中心智核 Spark */}
      <circle cx="61" cy="53" r="6" fill="var(--mint, #0f9d8f)" />
      <path d="M61 47 Q61 53 67 53 Q61 53 61 59 Q61 53 55 53 Q61 53 61 47 Z" fill="#ffffff" />
    </svg>
  )
}
