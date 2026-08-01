FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV CI=true
ENV NODE_ENV=development

# Keep the font set deterministic for design-system captures, including
# emoji and the common Noto glyph ranges used by dogfood applications.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    fontconfig \
    fonts-noto-core \
    fonts-noto-color-emoji \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

# Arguments are passed to the package's low-level capture command:
#   docker run --rm <image> <url> <out.png> <width>x<height> [selector]
ENTRYPOINT ["pnpm", "capture", "--"]
