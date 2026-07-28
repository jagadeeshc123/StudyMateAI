export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      documents: {
        Row: {
          created_at: string
          display_name: string | null
          file_size: number
          id: string
          mime_type: string
          original_file_name: string
          page_count: number | null
          processing_error: string | null
          processing_status: string
          storage_path: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          file_size: number
          id?: string
          mime_type?: string
          original_file_name: string
          page_count?: number | null
          processing_error?: string | null
          processing_status?: string
          storage_path: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          file_size?: number
          id?: string
          mime_type?: string
          original_file_name?: string
          page_count?: number | null
          processing_error?: string | null
          processing_status?: string
          storage_path?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          chunk_index: number
          content: string
          content_hash: string
          created_at: string
          document_id: string
          embedded_at: string | null
          embedding: string | null
          embedding_error: string | null
          embedding_model: string | null
          embedding_status: string
          id: string
          page_number: number
        }
        Insert: {
          chunk_index: number
          content: string
          content_hash: string
          created_at?: string
          document_id: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_error?: string | null
          embedding_model?: string | null
          embedding_status?: string
          id?: string
          page_number: number
        }
        Update: {
          chunk_index?: number
          content?: string
          content_hash?: string
          created_at?: string
          document_id?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_error?: string | null
          embedding_model?: string | null
          embedding_status?: string
          id?: string
          page_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          created_at: string
          document_id: string
          id: string
          role: string
        }
        Insert: {
          content: string
          created_at?: string
          document_id: string
          id?: string
          role: string
        }
        Update: {
          content?: string
          created_at?: string
          document_id?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clear_user_history: {
        Args: {
          target_document_id?: string | null
        }
        Returns: undefined
      }
      list_user_documents: {
        Args: Record<PropertyKey, never>
        Returns: {
          chunk_count: number
          created_at: string
          display_name: string | null
          embedded_chunk_count: number
          embedding_error: string | null
          embedding_model: string | null
          embedding_status: string
          file_size: number
          id: string
          message_count: number
          mime_type: string
          original_file_name: string
          page_count: number | null
          processing_error: string | null
          processing_status: string
        }[]
      }
      list_documents: {
        Args: Record<PropertyKey, never>
        Returns: {
          created_at: string
          file_size: number
          id: string
          mime_type: string
          original_file_name: string
          processing_status: string
        }[]
      }
      search_document_chunks: {
        Args: {
          match_count?: number
          search_query: string
          target_document_id: string
        }
        Returns: {
          chunk_index: number
          content: string
          id: string
          page_number: number
          rank: number
        }[]
      }
      hybrid_search_document_chunks: {
        Args: {
          keyword_query: string
          keyword_weight?: number
          match_count?: number
          query_embedding: string
            requested_page_numbers?: number[] | null
            semantic_weight?: number
            target_embedding_model?: string
            target_document_id: string
        }
        Returns: {
          chunk_index: number
          combined_score: number
          content: string
          document_id: string
          id: string
          keyword_score: number | null
          page_number: number
          semantic_score: number | null
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
