# Image format fixtures

These are genuine, small image files, each showing a green 64×48 rectangle with a red top-left corner. PNG, JPG, GIF, WebP, BMP, ICO, AVIF and JFIF were encoded using Pillow; SVG was authored as SVG. JFIF is the JPEG/JFIF encoding with its supported `.jfif` extension. ICO contains embedded image sizes. GIF is a static single-frame fixture; animated playback is outside this suite.

The files are committed so running the tests requires neither Pillow nor an image encoder. The test uses the browser image picker and checks rendered green pixels, exact post-import bytes after reload, and persistent movement. Cloud mode removes cached image bytes before private/shared reloads and requires gateway reads; network capture asserts two uploads (one per root) and zero image transfers during movement. The editor may normalize formats on import, so the report records the stored MIME type.
