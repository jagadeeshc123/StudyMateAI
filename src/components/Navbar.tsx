import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BookOpen, Upload, MessageSquare, LogOut, Files, History } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

const Navbar = () => {
  const { user, loading, signOut } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not log out.");
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center space-x-2">
          <BookOpen className="h-6 w-6 text-primary" />
          <span className="text-xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
            StudyMate
          </span>
        </Link>
        
        <div className="flex items-center space-x-1 sm:space-x-2">
          {!loading && user ? (
            <>
              <span className="hidden max-w-32 truncate text-xs text-muted-foreground md:inline xl:max-w-40 xl:text-sm" title={user.email}>
                {user.email}
              </span>
              <Link to="/upload">
                <Button variant="ghost" size="sm" title="Upload PDFs" aria-label="Upload PDFs">
                  <Upload className="h-4 w-4 lg:mr-2" />
                  <span className="hidden lg:inline">Upload</span>
                </Button>
              </Link>
              <Link to="/documents">
                <Button variant="ghost" size="sm" title="Documents" aria-label="Documents">
                  <Files className="h-4 w-4 lg:mr-2" />
                  <span className="hidden lg:inline">Documents</span>
                </Button>
              </Link>
              <Link to="/chat">
                <Button variant="default" size="sm" title="Chat" aria-label="Chat">
                  <MessageSquare className="h-4 w-4 lg:mr-2" />
                  <span className="hidden lg:inline">Chat</span>
                </Button>
              </Link>
              <Link to="/history">
                <Button variant="ghost" size="sm" title="Q&A History" aria-label="Q&A History">
                  <History className="h-4 w-4 lg:mr-2" />
                  <span className="hidden lg:inline">History</span>
                </Button>
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                aria-label="Log out"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </>
          ) : !loading ? (
            <Link to="/login">
              <Button variant="default">Log in</Button>
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground" role="status">Loading...</span>
          )}
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
