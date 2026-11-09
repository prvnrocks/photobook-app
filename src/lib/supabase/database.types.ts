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
      agent_runs: {
        Row: {
          ai_status: string | null
          attempts: number
          book_id: string | null
          critic_score: number | null
          cursor: Json
          error_code: string | null
          finished_at: string | null
          id: string
          lease_token: string | null
          lease_until: string | null
          mode: string
          progress: Json
          started_at: string
          state: string
          total_cost_usd: number
          total_input_tokens: number
          total_output_tokens: number
          trigger: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          ai_status?: string | null
          attempts?: number
          book_id?: string | null
          critic_score?: number | null
          cursor?: Json
          error_code?: string | null
          finished_at?: string | null
          id?: string
          lease_token?: string | null
          lease_until?: string | null
          mode: string
          progress?: Json
          started_at?: string
          state?: string
          total_cost_usd?: number
          total_input_tokens?: number
          total_output_tokens?: number
          trigger: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          ai_status?: string | null
          attempts?: number
          book_id?: string | null
          critic_score?: number | null
          cursor?: Json
          error_code?: string | null
          finished_at?: string | null
          id?: string
          lease_token?: string | null
          lease_until?: string | null
          mode?: string
          progress?: Json
          started_at?: string
          state?: string
          total_cost_usd?: number
          total_input_tokens?: number
          total_output_tokens?: number
          trigger?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_steps: {
        Row: {
          agent: string
          attempt: number
          cache_read_tokens: number
          cache_write_tokens: number
          cost_usd: number
          created_at: string
          error: string | null
          id: string
          input_summary: Json | null
          input_tokens: number
          latency_ms: number | null
          model: string | null
          output: Json | null
          output_tokens: number
          run_id: string
          status: string
          step_key: string
          stop_reason: string | null
        }
        Insert: {
          agent: string
          attempt?: number
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          input_summary?: Json | null
          input_tokens?: number
          latency_ms?: number | null
          model?: string | null
          output?: Json | null
          output_tokens?: number
          run_id: string
          status: string
          step_key: string
          stop_reason?: string | null
        }
        Update: {
          agent?: string
          attempt?: number
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          input_summary?: Json | null
          input_tokens?: number
          latency_ms?: number | null
          model?: string | null
          output?: Json | null
          output_tokens?: number
          run_id?: string
          status?: string
          step_key?: string
          stop_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
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
          fingerprint: string
          height: number | null
          id: string
          lat: number | null
          lng: number | null
          original_bytes: number | null
          original_mime: string | null
          original_path: string | null
          phash: string | null
          place: string | null
          place_checked_at: string | null
          status: string
          taken_at: string | null
          thumb_path: string | null
          upload_state: string
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
          fingerprint: string
          height?: number | null
          id?: string
          lat?: number | null
          lng?: number | null
          original_bytes?: number | null
          original_mime?: string | null
          original_path?: string | null
          phash?: string | null
          place?: string | null
          place_checked_at?: string | null
          status?: string
          taken_at?: string | null
          thumb_path?: string | null
          upload_state?: string
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
          fingerprint?: string
          height?: number | null
          id?: string
          lat?: number | null
          lng?: number | null
          original_bytes?: number | null
          original_mime?: string | null
          original_path?: string | null
          phash?: string | null
          place?: string | null
          place_checked_at?: string | null
          status?: string
          taken_at?: string | null
          thumb_path?: string | null
          upload_state?: string
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
      user_memory: {
        Row: {
          prefs: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          prefs?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          prefs?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_agent_run: {
        Args: { p_lease_seconds: number; p_run_id: string }
        Returns: string
      }
      claim_finalize_run: {
        Args: { p_book_id: string; p_min_interval_seconds: number }
        Returns: number
      }
      create_agent_run_capped: {
        Args: {
          p_book_id: string
          p_daily_cap: number
          p_enforce: boolean
          p_mode: string
          p_rebuild_cap: number
          p_trigger: string
          p_user_id: string
        }
        Returns: Json
      }
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
      release_agent_run: {
        Args: { p_run_id: string; p_token: string }
        Returns: undefined
      }
      reserve_geocode_calls: {
        Args: { p_book_id: string; p_daily_cap: number; p_want: number }
        Returns: number
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
