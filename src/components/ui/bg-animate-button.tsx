import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

const outerDivVariants = cva("relative inline-block overflow-hidden", {
  variants: {
    size: {
      sm: "",
      default: "",
      lg: "",
    },
    rounded: {
      full: "rounded-full before:rounded-full",
      xl: "rounded-xl before:rounded-xl",
      "2xl": "rounded-2xl before:rounded-2xl",
      "3xl": "rounded-3xl before:rounded-3xl",
      sm: "rounded-sm before:rounded-sm",
      xs: "rounded-xs before:rounded-xs",
      base: "rounded before:rounded",
    },
  },
  defaultVariants: {
    size: "default",
  },
})

const innerSpanVariants = cva(
  [
    "absolute inset-[-1000%] m-auto block", // Base styles for positioning and display
  ],
  {
    variants: {
      animation: {
        pulse: "animate-pulse", // Pulsating effect
        "spin-fast": "animate-[spin_2s_linear_infinite]", // Continuous rotation
        "spin-slow": "animate-[spin_8s_linear_infinite]", // Bouncing effect
        spin: "animate-[spin_4s_linear_infinite]", // Bouncing effect
        // Add more animations here
      },
      gradient: {
        sunrise: "font-bold text-black",
        /*
         * theme：锥形渐变交给 CSS 变量（--cta-a / --cta-b），由 inline style
         * 落到 span 上 —— 不走 Tailwind arbitrary value。
         *
         * 原因：arbitrary value 里嵌 var() 与多层括号，JIT 扫描的 class 名要写成
         * 一长串下划线形式，可读性差且改动色值必须重编译。变量方案让九套皮肤
         * 直接在 main.css 里配颜色，与品牌图标 --brand-* 同一套路。
         */
        theme: "",
        ocean:
          "bg-[conic-gradient(from_90deg_at_50%_50%,#a1c4fd_0%,#c2e9fb_50%,#a1c4fd_100%)]",
        candy:
          "bg-[conic-gradient(from_90deg_at_50%_50%,#ff9a9e_0%,#fad0c4_50%,#fad0c4_90%,#ff9a9e_100%)]",
        forest:
          "bg-[conic-gradient(from_90deg_at_50%_50%,#85d797_0%,#1a806b_50%,#85d797_100%)]",
        sunset:
          "bg-[conic-gradient(from_90deg_at_50%_50%,#fe5d75_0%,#f5af19_50%,#fe5d75_100%)]",
        nebula:
          "bg-[conic-gradient(from_90deg_at_50%_50%,#A77BFE_0%,#8860D0_50%,#A77BFE_100%)]",
        default:
          "bg-[conic-gradient(from_90deg_at_50%_50%,#E2CBFF_0%,#393BB2_50%,#E2CBFF_100%)]",
      },
    },
    compoundVariants: [
      {
        animation: "spin",
        gradient: "sunrise",
        className: "duration-4s ease-linear", // Customizes the animation duration and easing for a specific variant
      },
    ],
    defaultVariants: {
      animation: "spin",
      gradient: "forest",
    },
  }
)

const buttonVariants = cva(
  "relative overflow-hidden px-6 py-2 text-sm transition-all duration-150 ease-in-out disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      size: {
        sm: "px-4 py-1 text-xs",
        default: "px-6 py-2 text-sm",
        lg: "px-8 py-3 text-base",
      },
      shadow: {
        flat: "",
        soft: "shadow-[0_2px_4px_rgba(0,0,0,0.15),inset_0_1px_1px_rgba(255,255,255,0.15),inset_0_-1px_2px_rgba(0,0,0,0.3)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.25),inset_0_1px_1px_rgba(0,0,0,0.2),inset_0_-1px_2px_rgba(0,0,0,0.5)]",
        base: "shadow-[0_3px_5px_rgba(0,0,0,0.2),inset_0_0.5px_1px_rgba(255,255,255,0.1),inset_0_-2px_3px_rgba(0,0,0,0.4)] dark:shadow-[0_3px_5px_rgba(0,0,0,0.3),inset_0_0.5px_1px_rgba(0,0,0,0.2),inset_0_-2px_3px_rgba(0,0,0,0.6)]",
        deep: "shadow-[0_4px_6px_rgba(0,0,0,0.25),inset_0_1px_2px_rgba(255,255,255,0.2),inset_0_-2px_4px_rgba(0,0,0,0.5)] dark:shadow-[0_4px_6px_rgba(0,0,0,0.35),inset_0_1px_2px_rgba(0,0,0,0.3),inset_0_-2px_4px_rgba(0,0,0,0.7)]",
        deeper:
          "shadow-[0_6px_8px_rgba(0,0,0,0.3),inset_0_2px_3px_rgba(255,255,255,0.25),inset_0_-3px_6px_rgba(0,0,0,0.6)] dark:shadow-[0_6px_8px_rgba(0,0,0,0.4),inset_0_2px_3px_rgba(0,0,0,0.35),inset_0_-3px_6px_rgba(0,0,0,0.8)]",
      },
      gradient: {
        sunrise: "font-bold text-black",
        theme: "font-bold",
        ocean: "font-bold text-black",
        candy: "font-bold text-black",
        forest: "font-bold text-black",
        sunset: "font-bold text-black",
        nebula: "font-bold text-white",
        default: "font-bold text-white",
      },
      rounded: {
        full: "rounded-full before:rounded-full",
        xl: "rounded-xl before:rounded-xl",
        "2xl": "rounded-2xl before:rounded-2xl",
        "3xl": "rounded-3xl before:rounded-3xl",
        sm: "rounded-sm before:rounded-sm",
        xs: "rounded-xs before:rounded-xs",
        base: "rounded before:rounded",
      },
    },
    defaultVariants: {
      size: "default",
      shadow: "base",
      rounded: "xl",
    },
  }
)

export interface UnifiedButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "success" | "secondary" | "destructive" | "ghost"
  size?: "sm" | "lg" | "default"
  shadow?: "flat" | "soft" | "base" | "deep" | "deeper"
  rounded?: "full" | "xl" | "2xl" | "3xl" | "sm" | "xs" | "base"
  asChild?: boolean
  showBackground?: boolean
  animation?: "spin" | "pulse" | "spin-slow" | "spin-fast" | "spin"
  gradient?:
    | "sunrise"
    | "ocean"
    | "candy"
    | "default"
    | "forest"
    | "sunset"
    | "nebula"
    | "theme"
}

/*
 * theme 渐变的实际画面：与官方 candy 完全同构（起色 0% → 主色 50% → 起色 100%），
 * 只是两端的色值来自皮肤变量。锥形从右侧（90deg）起算，旋转时颜色自左向右推移。
 */
const THEME_CONIC =
  "conic-gradient(from 90deg at 50% 50%, var(--cta-a) 0%, var(--cta-b) 50%, var(--cta-a) 100%)"

const BgAnimateButton = React.forwardRef<HTMLButtonElement, UnifiedButtonProps>(
  (
    {
      variant = "primary",
      size = "default",
      showBackground = false,
      rounded = "full",
      shadow = "soft",
      gradient = null,
      animation = null,
      className,
      asChild = false,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button"
    const isTheme = gradient === "theme"

    return (
      <Comp
        className={cn(outerDivVariants({ size, rounded }), className)}
        ref={ref}
        {...props}
      >
        {gradient && (
          <span
            className={cn(innerSpanVariants({ gradient, animation }))}
            style={isTheme ? { backgroundImage: THEME_CONIC } : undefined}
          />
        )}

        <div
          className={cn(buttonVariants({ shadow, rounded, size, gradient }))}
          style={isTheme ? { color: "var(--cta-fg)" } : undefined}
        >
          {props.children || "Button"}
        </div>
      </Comp>
    )
  }
)

BgAnimateButton.displayName = "BgAnimateButton"

export { BgAnimateButton }
export default BgAnimateButton
