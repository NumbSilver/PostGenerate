import React from "react";
import { Img } from "remotion";
import type { PosterProject } from "../../src/lib/types";

export const PosterComposition: React.FC<{ project: PosterProject }> = ({ project }) => {
  const layers = project.layers.slice().sort((a, b) => a.z - b.z);

  return (
    <div style={{ width: project.canvas.width, height: project.canvas.height, position: "relative", background: "#000" }}>
      <Img
        src={project.canvas.background.url}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />

      {layers.map((layer) => {
        const common: React.CSSProperties = {
          position: "absolute",
          left: layer.x,
          top: layer.y,
          width: layer.w,
          height: layer.h,
          transform: `rotate(${layer.rotation}deg)`,
          transformOrigin: "top left"
        };

        if (layer.type === "text") {
          return (
            <div
              key={layer.id}
              style={{
                ...common,
                color: layer.color,
                fontFamily: layer.fontFamily,
                fontSize: layer.fontSize,
                fontWeight: layer.fontWeight,
                whiteSpace: "pre-wrap",
                lineHeight: 1.2,
                textAlign: layer.align
              }}
            >
              {layer.text}
            </div>
          );
        }

        return (
          <Img
            key={layer.id}
            src={layer.src}
            style={{
              ...common,
              objectFit: "contain"
            }}
          />
        );
      })}
    </div>
  );
};
