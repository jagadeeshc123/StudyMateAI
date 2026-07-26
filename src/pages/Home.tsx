import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import Navbar from "@/components/Navbar";
import heroImage from "@/assets/hero-bg.jpg";
import { Upload, MessageSquare, Brain, Zap, Lock, BookOpen } from "lucide-react";

const Home = () => {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      
      {/* Hero Section */}
      <section className="relative overflow-hidden py-20 sm:py-32">
        <div className="absolute inset-0 -z-10 opacity-20">
          <img 
            src={heroImage} 
            alt="StudyMate AI Platform" 
            className="h-full w-full object-cover"
          />
        </div>
        <div className="container px-4">
          <div className="mx-auto max-w-4xl text-center">
            <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
              Transform Your Study Materials with{" "}
              <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                AI-Powered Q&A
              </span>
            </h1>
            <p className="mb-8 text-lg text-muted-foreground sm:text-xl">
              Upload your textbooks, lecture notes, and research papers. Ask questions in natural language. 
              Get precise, contextualized answers instantly.
            </p>
            <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
              <Link to="/upload">
                <Button variant="hero" size="lg" className="w-full sm:w-auto">
                  <Upload className="mr-2 h-5 w-5" />
                  Upload Your First PDF
                </Button>
              </Link>
              <Link to="/chat">
                <Button variant="outline" size="lg" className="w-full sm:w-auto">
                  <MessageSquare className="mr-2 h-5 w-5" />
                  Chat with Documents
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 sm:py-24">
        <div className="container px-4">
          <h2 className="mb-12 text-center text-3xl font-bold sm:text-4xl">
            Why Students Love StudyMate
          </h2>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="border-2 transition-all hover:shadow-lg">
              <CardContent className="pt-6">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <Brain className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Smart Context Understanding</h3>
                <p className="text-muted-foreground">
                  Our AI understands your questions and retrieves the most relevant information from your documents.
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 transition-all hover:shadow-lg">
              <CardContent className="pt-6">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary/10">
                  <Zap className="h-6 w-6 text-secondary" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Lightning Fast Answers</h3>
                <p className="text-muted-foreground">
                  Get instant responses to your questions. No more searching through hundreds of pages manually.
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 transition-all hover:shadow-lg">
              <CardContent className="pt-6">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10">
                  <BookOpen className="h-6 w-6 text-accent" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Source References</h3>
                <p className="text-muted-foreground">
                  Every answer includes references to the exact pages and sections in your documents.
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 transition-all hover:shadow-lg">
              <CardContent className="pt-6">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <Upload className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Multi-Document Support</h3>
                <p className="text-muted-foreground">
                  Upload multiple PDFs and query across all your study materials simultaneously.
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 transition-all hover:shadow-lg">
              <CardContent className="pt-6">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary/10">
                  <Lock className="h-6 w-6 text-secondary" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Private & Secure</h3>
                <p className="text-muted-foreground">
                  Your documents stay private. We use secure processing and never share your study materials.
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 transition-all hover:shadow-lg">
              <CardContent className="pt-6">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10">
                  <MessageSquare className="h-6 w-6 text-accent" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Natural Language</h3>
                <p className="text-muted-foreground">
                  Ask questions just like you would to a study partner. No complex query syntax needed.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 sm:py-24">
        <div className="container px-4">
          <Card className="border-2 bg-gradient-to-r from-primary/5 to-secondary/5">
            <CardContent className="p-8 sm:p-12 text-center">
              <h2 className="mb-4 text-3xl font-bold sm:text-4xl">
                Ready to Study Smarter?
              </h2>
              <p className="mb-8 text-lg text-muted-foreground">
                Join thousands of students who are already using AI to ace their studies.
              </p>
              <Link to="/upload">
                <Button variant="hero" size="lg">
                  <Upload className="mr-2 h-5 w-5" />
                  Get Started Now - It's Free
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="container px-4 text-center text-sm text-muted-foreground">
          <p>© 2024 StudyMate. Powered by AI to help you learn better.</p>
        </div>
      </footer>
    </div>
  );
};

export default Home;
