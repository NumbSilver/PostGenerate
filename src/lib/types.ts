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
  lineHeight?: number;
  letterSpacing?: number;
  opacity?: number;
  stroke?: string;
  strokeWidth?: number;
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowOpacity?: number;
};

export type PosterImageLayer = PosterLayerBase & {
  type: "image";
  src: string;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  role?: "asset" | "guide_b_overlay" | "text_backdrop";
};

export type PosterLayer = PosterTextLayer | PosterImageLayer;

export type PosterInputTextContent = {
  title: string;
  subtitle?: string;
  others?: string[];
};

export type PosterLayoutBlock = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  rotation: number;
};

export type PosterLayoutPlan = {
  blocks: PosterLayoutBlock[];
  rationale?: string;
};

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
