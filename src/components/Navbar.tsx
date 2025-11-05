import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BookOpen, Upload, MessageSquare } from "lucide-react";

const Navbar = () => {
  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center space-x-2">
          <BookOpen className="h-6 w-6 text-primary" />
          <span className="text-xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
            StudyMate
          </span>
        </Link>
        
        <div className="flex items-center space-x-4">
          <Link to="/upload">
            <Button variant="ghost" className="hidden sm:flex">
              <Upload className="mr-2 h-4 w-4" />
              Upload PDFs
            </Button>
          </Link>
          <Link to="/chat">
            <Button variant="default">
              <MessageSquare className="mr-2 h-4 w-4" />
              Start Chat
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
