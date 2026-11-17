// ============================================================
// Slate — components/UncertainHighlight.tsx
// ============================================================
// Shows AI import's "[UNCERTAIN]" tag in red inside a form field,
// while the rest of the value stays in the normal text colour.
//
// HOW: a text box can only draw its text in one colour, so while the
// value holds the tag, a copy of the text is drawn behind the field
// (same class, so same font, size and wrapping) with the tag in red,
// and the field's own text is made transparent — its caret and
// selection still show. Without a tag the field is drawn normally.
//
// The wrapper is always rendered, so the field is never re-created
// while someone types (it would lose focus as the tag is deleted).
//
// The tag is matched case-insensitively: names are stored in Capital
// Case, which turns "[UNCERTAIN]" into "[uncertain]".
//
// FILE LOCATION:
//   src/components/UncertainHighlight.tsx
// ============================================================

import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type InputHTMLAttributes,
  type Ref,
} from "react";
import { hasUncertainTag } from "../utils/uncertain";

// split() with a capturing group keeps the matches, at the odd indexes.
const TAG_SPLIT = /(\[UNCERTAIN\])/i;

interface BackdropProps {
  text: string;
  className?: string;
  style?: CSSProperties;
  multiline?: boolean;
  backdropRef?: Ref<HTMLDivElement>;
}

/** The coloured copy drawn behind a field. */
export function UncertainBackdrop({ text, className = "", style, multiline, backdropRef }: BackdropProps) {
  const parts = text.split(TAG_SPLIT);
  return (
    <div
      ref={backdropRef}
      aria-hidden
      className={`${className} uncertain-backdrop${multiline ? " uncertain-backdrop-multi" : ""}`}
      style={style}
    >
      {parts.map((part, i) =>
        i % 2 === 1 ? <span key={i} className="uncertain-tag">{part}</span> : part
      )}
    </div>
  );
}

/** A single-line <input> that shows the [UNCERTAIN] tag in red. */
export function TagInput({ className = "", style, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const text = typeof rest.value === "string" ? rest.value : "";
  const tagged = hasUncertainTag(text);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // A long value scrolls sideways inside the input; keep the copy in step.
  const sync = () => {
    if (inputRef.current && backdropRef.current) {
      backdropRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  };
  useLayoutEffect(sync);

  return (
    <div className="uncertain-field">
      {tagged && (
        <UncertainBackdrop text={text} className={className} style={style} backdropRef={backdropRef} />
      )}
      <input
        {...rest}
        ref={inputRef}
        className={tagged ? `${className} uncertain-field-input` : className}
        style={style}
        onScroll={sync}
        onSelect={sync}
        onKeyUp={sync}
      />
    </div>
  );
}
