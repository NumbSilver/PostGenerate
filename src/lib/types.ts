export type PosterMeta = {
  provider: string;
  prompt: string;
  negativePrompt?: string;
  params: Record<string, unknown>;
};

export type PosterLayerBase = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
};

export type PosterTextLayer = PosterLayerBase & {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
};

export type PosterImageLayer = PosterLayerBase & {
  type: "image";
  src: string;
};

export type PosterLayer = PosterTextLayer | PosterImageLayer;

export type PosterProject = {
  id: string;
  createdAt: string;
  inputText: string;
  canvas: {
    width: number;
    height: number;
    background: { url: string };
  };
  meta: PosterMeta;
  layers: PosterLayer[];
};

