import React from "react";
import { Composition } from "remotion";
import { PosterComposition } from "./PosterComposition";
import type { PosterProject } from "../../src/lib/types";

type InputProps = {
  project: PosterProject;
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Poster"
      component={PosterComposition}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ project: undefined as unknown as PosterProject }}
      calculateMetadata={({ props }) => {
        const p = (props as InputProps | undefined)?.project;
        const width = p?.canvas?.width ?? 1080;
        const height = p?.canvas?.height ?? 1920;
        return { props, width, height, durationInFrames: 1, fps: 30 };
      }}
    />
  );
};
