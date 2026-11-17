// ============================================================
// Charted PWA — AutoTextarea.tsx
// ============================================================
// A <textarea> that grows with its content. Clinical notes can
// be long; a fixed-height box that the user has to scroll inside
// is frustrating on mobile. This component resizes itself to fit
// whatever the user has typed, so the page scrolls rather than
// the input.
//
// Usage is identical to a normal <textarea> — it forwards all
// standard props, so you can use it as a drop-in replacement.
// An AI import's [UNCERTAIN] tag inside it is shown in red.
//
// FILE LOCATION:
//   src/components/AutoTextarea.tsx
// ============================================================

import { useRef, useEffect, type TextareaHTMLAttributes } from "react";
import { UncertainBackdrop } from "./UncertainHighlight";
import { hasUncertainTag } from "../utils/uncertain";

type AutoTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function AutoTextarea({ value, onChange, className = "", style, ...rest }: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Recalculate height whenever value changes.
  // Strategy: reset to "auto" first so the scrollHeight reflects
  // the content, then set the height to exactly that. Using
  // scrollHeight avoids needing to measure line-height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // An AI import's [UNCERTAIN] tag is shown in red (UncertainHighlight.tsx).
  // The wrapper is always there so the textarea is never re-created mid-typing.
  const tagged = hasUncertainTag(value);

  return (
    <div className="uncertain-field">
      {tagged && <UncertainBackdrop text={value} className={className} style={style} multiline />}
      <textarea
        ref={ref}
        value={value}
        onChange={onChange}
        className={tagged ? `${className} uncertain-field-input` : className}
        style={style}
        {...rest}
      />
    </div>
  );
}
