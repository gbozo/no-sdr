# FFT Visuals

This document contains Mermaid diagrams for FFT-related visualizations.

## Mermaid Diagrams (inline)
```mermaid
graph TD
  Input[IQ Samples] --> FFT[FFT]
  FFT --> Peaks[Peaks/Bins]
  Peaks --> Compressed[Compression]
```

```mermaid
flowchart LR
  A[Time Domain] --> B[Frequency Domain]
  B --> C[Thresholding]
  C --> D[Indexed Peaks]
```

## How to Contribute Visuals
- Create a Mermaid diagram or an SVG illustration.
- Save assets under docs/images or docs/visuals.
- Reference diagrams in the main FFT doc via links or inline Mermaid blocks.
