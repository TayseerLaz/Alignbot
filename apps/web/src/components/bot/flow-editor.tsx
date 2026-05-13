'use client';

// Drag-and-drop conversation flow editor — Phase 2 §4.1.2.
//
// Each node represents one intent (greeting / product_inquiry / booking /
// support / escalation) plus a free-form label and the response template
// the bot should use when that intent fires. Edges represent fallthroughs
// — "if intent A is unresolved, also consider intent B."
//
// The bot-engine doesn't currently consume the graph as a strict state
// machine; it uses the response templates as additional context. The
// graph is documentation + the operator's mental model. When the runtime
// gets a graph-aware planner (Phase 2.5), the same JSON drives it.

import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const INTENT_PRESETS = [
  { key: 'greeting', label: 'Greeting' },
  { key: 'product_inquiry', label: 'Product inquiry' },
  { key: 'booking', label: 'Booking' },
  { key: 'support', label: 'Support' },
  { key: 'escalation', label: 'Escalation → human' },
];

interface IntentNodeData extends Record<string, unknown> {
  intent: string;
  label: string;
  response: string;
}

type IntentNode = Node<IntentNodeData>;

interface FlowSnapshot {
  nodes: { id: string; intent: string; label: string; response: string; x: number; y: number }[];
  edges: { id: string; source: string; target: string }[];
}

export function FlowEditor({
  initial,
  onSave,
  saving,
}: {
  initial: { conversationFlow: Record<string, unknown> | null };
  onSave: (snapshot: FlowSnapshot) => void;
  saving: boolean;
}) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner initial={initial} onSave={onSave} saving={saving} />
    </ReactFlowProvider>
  );
}

function FlowEditorInner({
  initial,
  onSave,
  saving,
}: {
  initial: { conversationFlow: Record<string, unknown> | null };
  onSave: (snapshot: FlowSnapshot) => void;
  saving: boolean;
}) {
  const reactFlow = useReactFlow();
  const [nodes, setNodes] = useState<IntentNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Hydrate from existing config. If conversationFlow has the new
  // graph shape (`nodes` + `edges`), use it. Otherwise fall back to the
  // legacy intent-keyed object and synthesise a default 5-node row.
  useEffect(() => {
    const cf = (initial.conversationFlow ?? {}) as {
      nodes?: { id: string; intent: string; label: string; response: string; x: number; y: number }[];
      edges?: { id: string; source: string; target: string }[];
    };
    if (cf.nodes && cf.edges) {
      setNodes(
        cf.nodes.map((n) => ({
          id: n.id,
          type: 'intent',
          position: { x: n.x, y: n.y },
          data: { intent: n.intent, label: n.label, response: n.response },
        })),
      );
      setEdges(cf.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })));
      return;
    }
    // Legacy layout: read each intent key as a row, lay out left → right.
    const legacy = (initial.conversationFlow ?? {}) as Record<string, string>;
    const presetNodes: IntentNode[] = INTENT_PRESETS.map((p, i) => ({
      id: p.key,
      type: 'intent',
      position: { x: 60 + i * 240, y: 60 },
      data: {
        intent: p.key,
        label: p.label,
        response: typeof legacy[p.key] === 'string' ? (legacy[p.key] as string) : '',
      },
    }));
    setNodes(presetNodes);
    // Default fallthrough: every intent → escalation.
    setEdges(
      INTENT_PRESETS.filter((p) => p.key !== 'escalation').map((p) => ({
        id: `${p.key}->escalation`,
        source: p.key,
        target: 'escalation',
      })),
    );
  }, [initial.conversationFlow]);

  const onNodesChange = useCallback(
    (changes: NodeChange<IntentNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, id: `${c.source}->${c.target}` }, es)),
    [],
  );

  const addNode = () => {
    const id = `intent-${Date.now()}`;
    const center = reactFlow.screenToFlowPosition({ x: 200, y: 200 });
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'intent',
        position: center,
        data: { intent: id, label: 'New intent', response: '' },
      },
    ]);
    setSelectedId(id);
  };

  const updateSelected = (patch: Partial<IntentNodeData>) => {
    if (!selectedId) return;
    setNodes((ns) =>
      ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)),
    );
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const save = () => {
    const snapshot: FlowSnapshot = {
      nodes: nodes.map((n) => ({
        id: n.id,
        intent: n.data.intent,
        label: n.data.label,
        response: n.data.response,
        x: n.position.x,
        y: n.position.y,
      })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    onSave(snapshot);
  };

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  return (
    <div className="flex h-[min(78vh,900px)] min-h-[640px] w-full overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          fitViewOptions={{ padding: 0.1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <div className="flex w-80 shrink-0 flex-col border-l border-border bg-surface-muted/30">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-white p-3">
          <Button size="sm" variant="secondary" onClick={addNode}>
            <Plus className="size-4" /> Add intent
          </Button>
          <Button size="sm" onClick={save} loading={saving}>
            <Save className="size-4" /> Save
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {!selected ? (
            <p className="text-foreground-muted">
              Click any node on the canvas to edit its intent and the response template the bot will
              use. Drag from the right-hand handle of one node to the left-hand handle of another to
              add a fallthrough.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground-muted">Label</label>
                <Input
                  value={selected.data.label}
                  onChange={(e) => updateSelected({ label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground-muted">
                  Intent key (lowercase, no spaces)
                </label>
                <Input
                  value={selected.data.intent}
                  onChange={(e) =>
                    updateSelected({
                      intent: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground-muted">Response template</label>
                <Textarea
                  rows={6}
                  value={selected.data.response}
                  onChange={(e) => updateSelected({ response: e.target.value })}
                  placeholder="The bot will use this as guidance when this intent fires."
                />
              </div>
              <Button variant="ghost" className="w-full text-red-600" onClick={deleteSelected}>
                Delete this node
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IntentNodeView({ data, selected }: NodeProps<IntentNode>) {
  return (
    <div
      className={cn(
        // Wider + taller node so titles + response previews are
        // readable without zooming. line-clamp on the response keeps
        // very long templates bounded but operator can still see the
        // first ~5 lines at a glance.
        'w-[300px] rounded-lg border bg-white px-4 py-3 shadow-sm',
        selected ? 'border-brand-500 ring-2 ring-brand-300' : 'border-border',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !bg-brand-400 !border-2 !border-white"
      />
      <p className="font-mono text-[11px] uppercase tracking-wide text-foreground-subtle">
        {data.intent}
      </p>
      <p className="mt-0.5 text-base font-semibold leading-tight text-foreground">
        {data.label || 'Untitled intent'}
      </p>
      {data.response ? (
        <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-xs text-foreground-muted">
          {data.response}
        </p>
      ) : (
        <p className="mt-2 text-xs italic text-foreground-subtle">no response template</p>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-3 !bg-brand-400 !border-2 !border-white"
      />
    </div>
  );
}

const NODE_TYPES = { intent: IntentNodeView };
