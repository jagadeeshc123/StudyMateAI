import { useState } from "react";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, BookOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const Chat = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Hello! I'm your AI study assistant. Upload your PDFs and ask me any questions about your study materials. I'll provide detailed answers with references to the source content.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const uploadedPDFs = JSON.parse(sessionStorage.getItem("uploadedPDFs") || "[]");

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage: Message = { role: "user", content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    // Simulate AI response (will be replaced with actual AI integration)
    setTimeout(() => {
      const assistantMessage: Message = {
        role: "assistant",
        content: `I understand you're asking: "${input}"\n\nTo provide accurate answers from your PDFs, I need to be connected to the AI backend. Currently, this is a demo interface. Once Lovable Cloud is enabled, I'll be able to:\n\n• Parse and analyze your uploaded PDFs\n• Search for relevant content using semantic search\n• Generate contextual answers with source references\n• Cite specific pages and sections\n\nWould you like to enable the AI backend now?`,
      };
      setMessages(prev => [...prev, assistantMessage]);
      setIsLoading(false);
    }, 1500);
  };

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      
      <div className="container flex-1 px-4 py-6">
        <div className="mx-auto flex h-full max-w-5xl flex-col">
          {/* Header */}
          <div className="mb-6">
            <h1 className="mb-2 text-3xl font-bold">Chat with Your Documents</h1>
            {uploadedPDFs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                <p className="text-sm text-muted-foreground">Active documents:</p>
                {uploadedPDFs.map((filename: string, idx: number) => (
                  <span
                    key={idx}
                    className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                  >
                    <BookOpen className="mr-1 h-3 w-3" />
                    {filename}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No documents uploaded yet. Upload PDFs to get started!
              </p>
            )}
          </div>

          {/* Chat Messages */}
          <Card className="mb-4 flex-1 border-2">
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100vh-24rem)] p-6">
                <div className="space-y-6">
                  {messages.map((message, index) => (
                    <div
                      key={index}
                      className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-lg px-4 py-3 ${
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted"
                        }`}
                      >
                        {message.role === "assistant" && (
                          <div className="mb-2 flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-primary" />
                            <span className="text-xs font-semibold text-primary">AI Assistant</span>
                          </div>
                        )}
                        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                      </div>
                    </div>
                  ))}
                  {isLoading && (
                    <div className="flex justify-start">
                      <div className="max-w-[80%] rounded-lg bg-muted px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 animate-bounce rounded-full bg-primary" />
                          <div className="h-2 w-2 animate-bounce rounded-full bg-primary delay-100" />
                          <div className="h-2 w-2 animate-bounce rounded-full bg-primary delay-200" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Input Area */}
          <Card className="border-2">
            <CardContent className="p-4">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
                className="flex gap-2"
              >
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask a question about your documents..."
                  className="flex-1"
                  disabled={isLoading}
                />
                <Button
                  type="submit"
                  variant="hero"
                  disabled={isLoading || !input.trim()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
              <p className="mt-2 text-xs text-muted-foreground">
                Press Enter to send • AI responses are generated based on your uploaded PDFs
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Chat;
