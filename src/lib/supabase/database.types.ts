// Generated from the live schema by `npm run db:types` (supabase gen types). Do not edit by hand.
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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      books: {
        Row: {
          ai_status: string
          caption_lang: string
          created_at: string
          doc: Json
          expires_at: string | null
          id: string
          is_paid: boolean
          max_pages: number
          occasion: string | null
          page_count: number
          password_hash: string | null
          published_at: string | null
          slug: string | null
          title: string | null
          tone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_status?: string
          caption_lang?: string
          created_at?: string
          doc?: Json
          expires_at?: string | null
          id?: string
          is_paid?: boolean
          max_pages?: number
          occasion?: string | null
          page_count?: number
          password_hash?: string | null
          published_at?: string | null
          slug?: string | null
          title?: string | null
          tone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_status?: string
          caption_lang?: string
          created_at?: string
          doc?: Json
          expires_at?: string | null
          id?: string
          is_paid?: boolean
          max_pages?: number
          occasion?: string | null
          page_count?: number
          password_hash?: string | null
          published_at?: string | null
          slug?: string | null
          title?: string | null
          tone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          amount: number
          book_id: string | null
          created_at: string
          currency: string
          id: string
          status: string
          stripe_session_id: string | null
          type: string
          user_id: string | null
        }
        Insert: {
          amount: number
          book_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          status?: string
          stripe_session_id?: string | null
          type: string
          user_id?: string | null
        }
        Update: {
          amount?: number
          book_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          status?: string
          stripe_session_id?: string | null
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          ai: Json | null
          blur_score: number | null
          book_id: string
          camera: string | null
          created_at: string
          date_source: string | null
          drop_reason: string | null
          dup_group: number | null
          height: number | null
          id: string
          lat: number | null
          lng: number | null
          original_path: string | null
          phash: string | null
          place: string | null
          status: string
          taken_at: string | null
          thumb_path: string | null
          user_id: string
          user_override: boolean
          web_path: string | null
          width: number | null
        }
        Insert: {
          ai?: Json | null
          blur_score?: number | null
          book_id: string
          camera?: string | null
          created_at?: string
          date_source?: string | null
          drop_reason?: string | null
          dup_group?: number | null
          height?: number | null
          id?: string
          lat?: number | null
          lng?: number | null
          original_path?: string | null
          phash?: string | null
          place?: string | null
          status?: string
          taken_at?: string | null
          thumb_path?: string | null
          user_id: string
          user_override?: boolean
          web_path?: string | null
          width?: number | null
        }
        Update: {
          ai?: Json | null
          blur_score?: number | null
          book_id?: string
          camera?: string | null
          created_at?: string
          date_source?: string | null
          drop_reason?: string | null
          dup_group?: number | null
          height?: number | null
          id?: string
          lat?: number | null
          lng?: number | null
          original_path?: string | null
          phash?: string | null
          place?: string | null
          status?: string
          taken_at?: string | null
          thumb_path?: string | null
          user_id?: string
          user_override?: boolean
          web_path?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "photos_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          name: string | null
        }
        Insert: {
          created_at?: string
          id: string
          name?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_published_book: {
        Args: { p_slug: string }
        Returns: {
          caption_lang: string
          doc: Json
          expires_at: string
          has_password: boolean
          id: string
          is_expired: boolean
          is_paid: boolean
          page_count: number
          published_at: string
          slug: string
          title: string
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
