# Third-party notices

Taskliner includes the following third-party software.

## flatpickr

| Field | Value |
| --- | --- |
| Project | [flatpickr](https://flatpickr.js.org/) |
| Version | 4.6.13 |
| License | MIT |
| Copyright | Copyright (c) 2017 Gregory Petrosyan |
| Distribution | Vendored under `vendor/flatpickr/` (minified CSS/JS and Japanese locale) |
| Upstream | https://github.com/flatpickr/flatpickr |

### MIT License text (flatpickr)

```text
Copyright (c) 2017 Gregory Petrosyan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other notes

- The QR generation used for device pairing (`src/pairing/qr-code.mjs`) is a compact in-repo implementation of QR Code Model 2 (error-correction level M). It is part of the Taskliner source tree under the project MIT License.
- Runtime platform services (browsers, Cloudflare, Google APIs, Discord webhooks) are not redistributed in this repository.
