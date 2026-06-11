export interface SidebarChannel {
  _id: string;
  slug: string;
  name: string;
  profile_image_url: string;
  profile_image_id?: string;
  media_count: number;
  is_live: boolean;
}

export interface SidebarCategory {
  _id: string;
  name: string;
}
