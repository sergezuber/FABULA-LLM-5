import { ComponentProps } from "solid-js"

// FABULA brand marks. The Mark/Splash are the "F" glyph in a square; the Logo is the wordmark.
// All colors come from the theme's icon tokens so the marks follow light/dark schemes.

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M5 18V10H8V18H5Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M5 2H13V5H8V8.5H12V11.5H8V18H5V2Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M28 90V50H40V90H28Z" fill="var(--icon-base)" />
      <path d="M28 10H62V22H40V42H58V54H40V90H28V10Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="117"
        y="31"
        text-anchor="middle"
        fill="var(--icon-strong-base)"
        font-family="var(--font-family-sans, sans-serif)"
        font-size="30"
        font-weight="700"
        letter-spacing="2"
      >
        FABULA-LLM-5
      </text>
    </svg>
  )
}
