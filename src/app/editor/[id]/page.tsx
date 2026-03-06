import dynamic from "next/dynamic";

const EditorClient = dynamic(() => import("./EditorClient"), { ssr: false });

export default function EditorPage({ params }: { params: { id: string } }) {
  return <EditorClient projectId={params.id} />;
}

