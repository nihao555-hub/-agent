import { useEffect, useState } from "react";
import { Badge, Card } from "../ui";
import { IconBook } from "../icons";

interface Item {
  id: string;
  topic: string;
  title: string;
  text: string;
}

export default function Knowledge() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    fetch("/api/playbook")
      .then((r) => r.json())
      .then((d) => setItems(d.items ?? []))
      .catch(() => setItems([]));
  }, []);

  const topics = Array.from(new Set(items.map((i) => i.topic)));

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-serif text-[28px] tracking-[-0.02em] text-ink">销售方法论库</h1>
        <p className="mt-1 text-[14px] text-muted">
          智能体推理时检索并引用这些片段（RAG 溯源）。每条都有稳定 ID，结论可反查到出处。
        </p>
      </header>

      <div className="space-y-6">
        {topics.map((topic) => (
          <div key={topic}>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-serif text-[18px] text-ink">{topic}</h2>
              <span className="text-[12px] text-muted">
                {items.filter((i) => i.topic === topic).length} 条
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {items
                .filter((i) => i.topic === topic)
                .map((i) => (
                  <Card key={i.id} title={i.title} icon={<IconBook />} meta={<Badge>{i.id}</Badge>}>
                    <p className="text-[13.5px] leading-6 text-charcoal">{i.text}</p>
                  </Card>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
