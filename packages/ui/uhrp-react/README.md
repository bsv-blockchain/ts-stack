# The `@bsv/uhrp-react` Package

UHRP-enabled React components for images, video, and audio.

## Install

Use React 18 or later and Node.js 22 or later to build your app.

```sh
npm install @bsv/uhrp-react
```

## Display an image or media source

Pass a UHRP address to resolve media through the SDK. You can also pass an HTTPS
URL. The example uses a regular HTTPS poster and a UHRP video address supplied by
the app.

```tsx
import { Img, Source } from '@bsv/uhrp-react'

type LessonMediaProps = {
  posterUrl: string
  videoUhrpUrl: string
}

export function LessonMedia({ posterUrl, videoUhrpUrl }: LessonMediaProps) {
  return (
    <section aria-label="Wallet tutorial">
      <Img
        src={posterUrl}
        alt="Wallet tutorial cover"
        width={640}
        height={360}
        fallback={<span role="status">Loading the cover…</span>}
      />
      <video controls preload="none" aria-label="Wallet tutorial">
        <Source src={videoUhrpUrl} type="video/mp4" />
        Your browser does not support video playback.
      </video>
    </section>
  )
}
```

| Component | Loading prop | Native attributes |
| --- | --- | --- |
| `Img` | `fallback` | Image attributes such as `alt`, `width`, and `loading="lazy"` |
| `Source` | `loading` | Source attributes such as `type` and `media` |

Supply the same `src` to components that should share lookup results. Resolved
URLs are cached for the browser session. A missing or failed lookup can be tried
again when the component remounts. A media element may need `.load()` when its
sources change after playback has started. Keep loading messages outside the
`video` and `audio` elements when they should be visible.

## URL resolution and content integrity

The SDK authenticates UHRP advertisements and resolves eligible HTTPS URLs. The
browser loads the displayed bytes from the chosen URL. Use the SDK's
`StorageDownloader.download()` when your application needs to verify the hash
of the downloaded bytes.

Run `npm test` to build the package and exercise fallback rendering, shared
lookups, retry, session persistence, and signed advertisement resolution. The
tests use local fixtures. See the [example app](./example) for a browser demo.

## License

The license for the code in this repository is the Apache License 2.0.